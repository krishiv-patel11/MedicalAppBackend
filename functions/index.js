const functions = require("firebase-functions");
const axios = require("axios");
const { lookupMedication } = require("./lookupMedication_backend");

const NEWS_API_KEY = "210f6f8c3dec4bfc9b64ed5f06e49c67";
const GOOGLE_API_KEY = "AIzaSyDu1n9K2ABggnzqYadz-ndk3R0CJ7qPtuo";
const CSE_ID = "c6f466dc10e86483d";
const VETERAN_BENEFITS_CSE_ID = "747adca65fef84cd1";
const VA_LOCATOR_CSE_ID = "91895026f68734993";

const setCORS = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
};

exports.getCommunityNews = functions.https.onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

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

    res.json({
      global: formatArticles(globalResponse.data.articles),
      local: formatArticles(localResponse.data.articles),
    });

  } catch (error) {
    console.error(
      "Error fetching news:",
      error.response?.data || error.message || error
    );

    res.status(500).json({
      error: "Error fetching news",
      details: error.response?.data || error.message,
    });
  }
});

exports.getSeniorBenefits = functions.https.onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const city = req.query.city || "New York";
    const state = req.query.state || "";
    const query = `senior citizen benefits in ${city} ${state}`;
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&cx=${CSE_ID}&num=10`;

    const response = await axios.get(url);
    const items = response.data.items || [];

    const results = items.map((item) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      displayLink: item.displayLink,
    }));

    res.json({ results });
  } catch (error) {
    console.error("Error fetching senior benefits:", error.response?.data || error.message || error);
    res.status(500).json({ error: "Failed to fetch benefits", details: error.response?.data || error.message });
  }
});

exports.getVeteranBenefits = functions.https.onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const city = req.query.city || "New York";
    const state = req.query.state || "";
    const query = `veteran benefits in ${city} ${state}`;
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&cx=${VETERAN_BENEFITS_CSE_ID}&num=10`;

    const response = await axios.get(url);
    const items = response.data.items || [];

    const results = items.map((item) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      displayLink: item.displayLink,
    }));

    res.json({ results });
  } catch (error) {
    console.error("Error fetching veteran benefits:", error.response?.data || error.message || error);
    res.status(500).json({ error: "Failed to fetch veteran benefits", details: error.response?.data || error.message });
  }
});

exports.getVAOffices = functions.https.onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const city = req.query.city || "New York";
    const state = req.query.state || "";
    const query = `VA offices, clinics, or veteran services in ${city} ${state}`;
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&cx=${VA_LOCATOR_CSE_ID}&num=10`;

    const response = await axios.get(url);
    const items = response.data.items || [];

    const results = items.map((item) => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      displayLink: item.displayLink,
    }));

    res.json({ results });
  } catch (error) {
    console.error("Error fetching VA offices:", error.response?.data || error.message || error);
    res.status(500).json({
      error: "Failed to fetch VA offices",
      details: error.response?.data || error.message
    });
  }
});

// MedScan medication lookup
exports.lookupMedication = lookupMedication;