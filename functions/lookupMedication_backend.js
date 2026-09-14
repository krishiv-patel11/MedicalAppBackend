const functions = require("firebase-functions");
const axios = require("axios");

const setCORS = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
};

const first = (value) => {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  return value || null;
};

const asArray = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }

  return [String(value)];
};

/*
 * Extract useful numeric identifiers from a barcode or QR payload.
 *
 * Supported examples:
 *   036800119504
 *   12345678901
 *   https://example.com/?ndc=12345678901
 *   https://example.com/?upc=036800119504
 */
const extractIdentifiers = (value) => {
  const text = String(value || "").trim();
  const identifiers = [];

  const addIdentifier = (candidate) => {
    if (!candidate) {
      return;
    }

    const digits = String(candidate).replace(/\D/g, "");

    if (!digits) {
      return;
    }

    // Medication identifiers are normally in this range.
    if (digits.length < 8 || digits.length > 14) {
      return;
    }

    if (!identifiers.includes(digits)) {
      identifiers.push(digits);
    }
  };

  /*
   * If the QR/barcode itself is just a numeric identifier,
   * use it directly.
   */
  if (/^\d{8,14}$/.test(text)) {
    addIdentifier(text);
  }

  /*
   * If the QR contains an NDC such as:
   * 12345-6789-01
   */
  const ndcMatches =
    text.match(/\b\d{4,5}[-\s]\d{3,4}[-\s]\d{1,2}\b/g) || [];

  for (const match of ndcMatches) {
    addIdentifier(match);
  }

  /*
   * If the QR contains a URL, inspect its parameters.
   */
  try {
    const url = new URL(text);

    const parameterNames = [
      "ndc",
      "upc",
      "ean",
      "barcode",
      "gtin",
      "product_ndc",
      "package_ndc",
    ];

    for (const name of parameterNames) {
      const parameter = url.searchParams.get(name);

      if (parameter) {
        addIdentifier(parameter);
      }
    }

    /*
     * Check path components for a standalone numeric
     * medication identifier.
     */
    const pathParts = url.pathname.split("/");

    for (const part of pathParts) {
      if (/^\d{8,14}$/.test(part)) {
        addIdentifier(part);
      }
    }
  } catch (_) {
    // Not a URL. That's okay.
  }

  return identifiers;
};

/*
 * Generate possible FDA-style NDC formats.
 *
 * FDA commonly represents NDCs with hyphens, while
 * scanners may return a continuous 10- or 11-digit value.
 */
const possibleNdcFormats = (digits) => {
  const formats = [];

  if (digits.length === 10) {
    formats.push(
      `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`,
      `${digits.slice(0, 5)}-${digits.slice(5, 8)}-${digits.slice(8)}`,
      `${digits.slice(0, 5)}-${digits.slice(5, 9)}-${digits.slice(9)}`
    );
  }

  if (digits.length === 11) {
    formats.push(
      `${digits.slice(0, 5)}-${digits.slice(5, 9)}-${digits.slice(9)}`,
      `${digits.slice(0, 5)}-${digits.slice(5, 8)}-${digits.slice(8)}`,
      `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`
    );
  }

  return [...new Set(formats)];
};

const fdaRequest = async (url) => {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
    });

    return response.data;
  } catch (error) {
    /*
     * 404 from openFDA normally just means "no matching record."
     * Don't turn that into a server failure.
     */
    if (error.response?.status === 404) {
      return null;
    }

    console.error(
      "FDA request failed:",
      error.response?.data || error.message || error
    );

    return null;
  }
};

exports.lookupMedication = functions.https.onRequest(async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const rawCode = String(req.query.barcode || "").trim();

    if (!rawCode) {
      return res.status(400).json({
        error: "Missing barcode or QR code value.",
      });
    }

    console.log("MedScan received:", rawCode);

    const identifiers = extractIdentifiers(rawCode);

    console.log("Extracted identifiers:", identifiers);

    if (identifiers.length === 0) {
      return res.status(400).json({
        error:
          "The scanned QR/barcode does not contain a supported medication identifier.",
        scannedCode: rawCode,
      });
    }

    let product = null;
    let matchedIdentifier = null;

    /*
     * Search each extracted identifier.
     */
    for (const identifier of identifiers) {
      if (product) {
        break;
      }

      /*
       * -------------------------------------------------------
       * 1. UPC
       * -------------------------------------------------------
       */
      const upcURL =
        "https://api.fda.gov/drug/ndc.json?search=" +
        encodeURIComponent(`openfda.upc:"${identifier}"`) +
        "&limit=1";

      const upcData = await fdaRequest(upcURL);

      if (upcData?.results?.[0]) {
        product = upcData.results[0];
        matchedIdentifier = identifier;
        break;
      }

      /*
       * -------------------------------------------------------
       * 2. Exact package NDC
       * -------------------------------------------------------
       */
      const packageURL =
        "https://api.fda.gov/drug/ndc.json?search=" +
        encodeURIComponent(`package_ndc:"${identifier}"`) +
        "&limit=1";

      const packageData = await fdaRequest(packageURL);

      if (packageData?.results?.[0]) {
        product = packageData.results[0];
        matchedIdentifier = identifier;
        break;
      }

      /*
       * -------------------------------------------------------
       * 3. Exact product NDC
       * -------------------------------------------------------
       */
      const productURL =
        "https://api.fda.gov/drug/ndc.json?search=" +
        encodeURIComponent(`product_ndc:"${identifier}"`) +
        "&limit=1";

      const productData = await fdaRequest(productURL);

      if (productData?.results?.[0]) {
        product = productData.results[0];
        matchedIdentifier = identifier;
        break;
      }

      /*
       * -------------------------------------------------------
       * 4. Try FDA's hyphenated NDC formats
       * -------------------------------------------------------
       */
      const ndcFormats = possibleNdcFormats(identifier);

      for (const formattedNdc of ndcFormats) {
        if (product) {
          break;
        }

        const formattedPackageURL =
          "https://api.fda.gov/drug/ndc.json?search=" +
          encodeURIComponent(`package_ndc:"${formattedNdc}"`) +
          "&limit=1";

        const formattedPackageData =
          await fdaRequest(formattedPackageURL);

        if (formattedPackageData?.results?.[0]) {
          product = formattedPackageData.results[0];
          matchedIdentifier = identifier;
          break;
        }

        const formattedProductURL =
          "https://api.fda.gov/drug/ndc.json?search=" +
          encodeURIComponent(`product_ndc:"${formattedNdc}"`) +
          "&limit=1";

        const formattedProductData =
          await fdaRequest(formattedProductURL);

        if (formattedProductData?.results?.[0]) {
          product = formattedProductData.results[0];
          matchedIdentifier = identifier;
          break;
        }
      }
    }

    /*
     * -------------------------------------------------------
     * No medication found
     * -------------------------------------------------------
     */
    if (!product) {
      return res.status(200).json({
        medication: null,
        scannedCode: rawCode,
        message:
          "The code was scanned successfully, but no matching medication was found in the FDA NDC database.",
      });
    }

    /*
     * -------------------------------------------------------
     * Extract medication information
     * -------------------------------------------------------
     */
    const openFDA = product.openfda || {};

    const brandName =
      first(openFDA.brand_name) ||
      product.brand_name ||
      null;

    const genericName =
      first(openFDA.generic_name) ||
      product.generic_name ||
      null;

    const activeIngredients = asArray(
      product.active_ingredient ||
        openFDA.substance_name
    );

    const packageNdc =
      product.package_ndc ||
      first(openFDA.package_ndc);

    const productNdc =
      product.product_ndc ||
      first(openFDA.product_ndc);

    /*
     * -------------------------------------------------------
     * Retrieve official FDA label
     * -------------------------------------------------------
     */
    let label = null;

    const labelQueries = [];

    if (packageNdc) {
      labelQueries.push(
        `openfda.package_ndc:"${packageNdc}"`
      );
    }

    if (productNdc) {
      labelQueries.push(
        `openfda.product_ndc:"${productNdc}"`
      );
    }

    if (brandName) {
      labelQueries.push(
        `openfda.brand_name:"${brandName}"`
      );
    }

    if (genericName) {
      labelQueries.push(
        `openfda.generic_name:"${genericName}"`
      );
    }

    for (const query of labelQueries) {
      const labelURL =
        "https://api.fda.gov/drug/label.json?search=" +
        encodeURIComponent(query) +
        "&limit=1";

      const labelData = await fdaRequest(labelURL);

      if (labelData?.results?.[0]) {
        label = labelData.results[0];
        break;
      }
    }

    /*
     * -------------------------------------------------------
     * Strength
     * -------------------------------------------------------
     */
    let strength = null;

    const strengthSource =
      activeIngredients.join(" ");

    const strengthMatch = strengthSource.match(
      /\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|kg|mL|L|%|units?)/i
    );

    if (strengthMatch) {
      strength = strengthMatch[0];
    }

    /*
     * -------------------------------------------------------
     * Build response
     * -------------------------------------------------------
     */
    const medication = {
      barcode: matchedIdentifier,

      brandName,

      genericName,

      activeIngredients,

      strength,

      dosageForm:
        product.dosage_form ||
        first(openFDA.dosage_form) ||
        null,

      route:
        first(openFDA.route) ||
        first(product.route) ||
        null,

      manufacturer:
        product.labeler_name ||
        first(openFDA.manufacturer_name) ||
        null,

      indications:
        first(
          label?.indications_and_usage ||
            label?.purpose
        ),

      warnings:
        first(
          label?.warnings ||
            label?.warnings_and_cautions
        ),

      contraindications:
        first(label?.contraindications),

      dosageAndAdministration:
        first(label?.dosage_and_administration),

      adverseReactions:
        first(label?.adverse_reactions),

      sourceName: "U.S. FDA / openFDA",

      sourceURL:
        "https://open.fda.gov/apis/drug/ndc/",
    };

    console.log(
      "Medication found:",
      brandName || genericName || "Unknown"
    );

    return res.status(200).json({
      medication,
    });
  } catch (error) {
    console.error(
      "Error looking up medication:",
      error.response?.data ||
        error.message ||
        error
    );

    return res.status(500).json({
      error: "Failed to look up medication.",
      details:
        error.message ||
        "Unknown server error",
    });
  }
});