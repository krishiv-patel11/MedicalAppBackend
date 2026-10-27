const functions = require("firebase-functions");
const axios = require("axios");
const { lookupMedication } = require("./lookupMedication_backend");
const {
  createIdentityVerification,
  diditWebhookV2,
} = require("./identityVerification");
const {
  createQRCodeToken,
  resolveQRCodeToken,
} = require("./qrVerification");

const NEWS_API_KEY = "210f6f8c3dec4bfc9b64ed5f06e49c67";

const setCORS = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
};


async function searchTavily(queries, maxResults = 25) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not configured.");
  }

  const searches = await Promise.all(
    queries.map(async (query) => {
      const response = await axios.post(
        "https://api.tavily.com/search",
        {
          api_key: apiKey,
          query,
          search_depth: "basic",
          max_results: 10,
          include_answer: false,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
          timeout: 25000,
        }
      );

      return response.data.results || [];
    })
  );

  const uniqueResults = new Map();

  for (const results of searches) {
    for (const item of results) {
      if (!item.url) continue;

      let normalizedUrl;

      try {
        const parsedUrl = new URL(item.url);
        parsedUrl.hash = "";
        parsedUrl.search = "";
        normalizedUrl = parsedUrl.toString().replace(/\/$/, "").toLowerCase();
      } catch (_) {
        continue;
      }

      if (uniqueResults.has(normalizedUrl)) continue;

      let displayLink = "";

      try {
        displayLink = new URL(item.url).hostname.replace(/^www\./, "");
      } catch (_) {}

      uniqueResults.set(normalizedUrl, {
        title: item.title || "Untitled result",
        snippet: item.content || "No description available.",
        link: item.url,
        displayLink,
      });
    }
  }

  return Array.from(uniqueResults.values()).slice(0, maxResults);
}

exports.getCommunityNews = functions.https.onRequest(async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const city = req.query.city || "New York";
    const state = req.query.state || "";
    const locationQuery = state ? `${city} ${state}` : city;

    const globalUrl = `https://newsapi.org/v2/top-headlines?country=us&pageSize=10&apiKey=${NEWS_API_KEY}`;
    const localUrl = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(locationQuery)}&country=us&pageSize=10&apiKey=${NEWS_API_KEY}`;

    const [globalResponse, localResponse] = await Promise.all([
      axios.get(globalUrl),
      axios.get(localUrl),
    ]);

    const formatArticles = (articles) =>
      (articles || []).slice(0, 3).map((article) => ({
        title: article.title,
        description: article.description || "No description available",
        link: article.url,
        pubDate: article.publishedAt,
        image_url: article.urlToImage || null,
        source_name: article.source?.name || "Unknown Source",
        creator: article.author || "Unknown Author",
      }));

    return res.json({
      global: formatArticles(globalResponse.data.articles),
      local: formatArticles(localResponse.data.articles),
    });
  } catch (error) {
    console.error(
      "Error fetching news:",
      error.response?.data || error.message || error
    );

    return res.status(500).json({
      error: "Error fetching news",
      details: "Unable to fetch community news right now.",
    });
  }
});

exports.getSeniorBenefits = functions
  .runWith({ secrets: ["TAVILY_API_KEY"] })
  .https.onRequest(async (req, res) => {
    setCORS(res);

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const city = req.query.city || "";
      const state = req.query.state || "";
      const location = [city, state].filter(Boolean).join(", ");
      const area = location ? `in or serving ${location}` : "available across the United States";

      const queries = [
        `Senior citizen assistance programs ${area}: government benefits, Medicare Savings Programs, SNAP, SSI, Extra Help prescription coverage, and property tax relief`,
        `Nonprofit and charitable assistance for seniors ${area}: emergency grants, rent assistance, utility bills, food, medical bills, and transportation`,
        `Senior discounts and free services ${area}: pharmacies, restaurants, grocery stores, internet, phone, transit, museums, and community programs`,
        `Official senior assistance resources ${area}: Area Agencies on Aging, elder services, Meals on Wheels, caregiver support, legal aid, and benefits screening`,
      ];

      const results = await searchTavily(queries, 25);


      return res.json({ results });
    } catch (error) {
      console.error(
        "Error fetching senior benefits:",
        error.response?.data || error.message || error
      );

      return res.status(500).json({
        error: "Failed to fetch benefits",
        details: "The benefits search is temporarily unavailable.",
      });
    }
  });

exports.getVeteranBenefits = functions
  .runWith({ secrets: ["TAVILY_API_KEY"] })
  .https.onRequest(async (req, res) => {
    setCORS(res);

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const city = req.query.city || "";
      const state = req.query.state || "";
      
      const location = [city, state].filter(Boolean).join(", ");
      const area = location ? `in or serving ${location}` : "available across the United States";

      const queries = [
        `Veteran benefits ${area}: VA disability compensation, pension, education, healthcare, housing, and dependent benefits`,
        `Nonprofit veteran assistance ${area}: emergency financial grants, rent, utilities, food, transportation, and medical expenses`,
        `Veteran discounts and free services ${area}: retail, restaurants, travel, technology, recreation, and community services`,
        `Official veteran support resources ${area}: accredited veterans service organizations, state veteran benefits, employment, legal aid, and charitable foundations`,
      ];

      const results = await searchTavily(queries, 25);


      return res.json({ results });
    } catch (error) {
      console.error(
        "Error fetching veteran benefits:",
        error.response?.data || error.message || error
      );

      return res.status(500).json({
        error: "Failed to fetch veteran benefits",
        details: "The benefits search is temporarily unavailable.",
      });
    }
  });

exports.getVAOffices = functions
  .runWith({ secrets: ["TAVILY_API_KEY"] })
  .https.onRequest(async (req, res) => {
    setCORS(res);

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const city = req.query.city || "";
      const state = req.query.state || "";
      const location = [city, state].filter(Boolean).join(", ");

      if (!location) {
        return res.status(400).json({
          error: "Please provide a city or state.",
        });
      }

      const query = [
        `Find VA offices, VA medical centers, VA clinics, and accredited veteran service organizations in ${location}.`,
        "Return official locations, addresses, contact details, and appointment information where available.",
        "Prioritize official VA websites and established accredited organizations.",
      ].join(" ");

      const results = await searchTavily(query);

      return res.json({ results });
    } catch (error) {
      console.error(
        "Error fetching VA offices:",
        error.response?.data || error.message || error
      );

      return res.status(500).json({
        error: "Failed to fetch VA offices",
        details: "The office search is temporarily unavailable.",
      });
    }
  });

exports.lookupMedication = lookupMedication;
exports.createIdentityVerification = createIdentityVerification;
exports.diditWebhookV2 = diditWebhookV2;
exports.createQRCodeToken = createQRCodeToken;
exports.resolveQRCodeToken = resolveQRCodeToken;
