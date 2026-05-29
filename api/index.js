require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const FirecrawlApp = require('@mendable/firecrawl-js').default;

const app = express();
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// In-memory cache: url -> { data, cachedAt }
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

app.use(cors());
app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Slow down.' },
}));

// Extract media links from markdown content
function extractMediaLinks(markdown = '') {
  const links = [];
  const regex = /\[([^\]]*)\]\((https?:\/\/[^\)]+)\)/g;
  let m;
  while ((m = regex.exec(markdown)) !== null) {
    const url = m[2];
    if (/\.(mp4|mp3|m4a|webm|mkv|avi|mov|flv|zip|pdf|jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) {
      links.push({ label: m[1] || null, url });
    }
  }
  return links;
}

app.get('/download', async (req, res) => {
  const { url, format = 'markdown' } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Missing required query param: url' });
  }

  // Basic URL validation
  try { new URL(url); } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL.' });
  }

  // Cache hit
  const cached = cache.get(url);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return res.json({ success: true, cached: true, ...cached.data });
  }

  const formats = format === 'both' ? ['markdown', 'html'] : ['markdown'];

  try {
    const result = await firecrawl.scrapeUrl(url, {
      formats,
      onlyMainContent: true,
    });

    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error || 'Firecrawl scrape failed.' });
    }

    const data = {
      title: result.metadata?.title || null,
      description: result.metadata?.description || null,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      content: {
        markdown: result.markdown || null,
        ...(format === 'both' && { html: result.html || null }),
      },
      mediaLinks: extractMediaLinks(result.markdown),
    };

    cache.set(url, { data, cachedAt: Date.now() });
    res.json({ success: true, cached: false, ...data });

  } catch (err) {
    const status = err.message?.includes('timeout') ? 504 : 502;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.get('/', (_req, res) => res.json({
  name: 'fdown.net Scraper API',
  endpoint: 'GET /download?url=<target_url>&format=markdown|html|both',
}));

app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found.' }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Kill the process or set a different PORT.`);
        process.exit(1);
      } else throw err;
    });
}

module.exports = app;
