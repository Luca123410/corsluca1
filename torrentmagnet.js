const axios = require("axios");
const cheerio = require("cheerio");

// Timeout aggressivi per stare nei 10s di Vercel
const TIMEOUT = 3500; 

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

// 1. SOLID TORRENTS API
async function searchSolid(query) {
    try {
        const url = `https://solidtorrents.to/api/v1/search?sort=seeders&q=${encodeURIComponent(query)}&category=Video`;
        const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
        return (data.results || []).map(r => ({
            title: r.title,
            magnet: r.magnet,
            size: (r.size / 1024 / 1024 / 1024).toFixed(2) + " GB",
            seeders: r.seeders,
            source: "Solid"
        }));
    } catch (e) { return []; }
}

// 2. BITSEARCH (HTML Leggero)
async function searchBitSearch(query) {
    try {
        const url = `https://bitsearch.to/search?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
        const $ = cheerio.load(data);
        let res = [];
        $('li.search-result').each((_, el) => {
            const title = $(el).find('h5.title a').text().trim();
            const magnet = $(el).find('a.dl-magnet').attr('href');
            const seeders = parseInt($(el).find('.stats div').eq(2).text()) || 0;
            const size = $(el).find('.stats div').eq(1).text();
            if(title && magnet) res.push({ title, magnet, size, seeders, source: "BitSearch" });
        });
        return res;
    } catch (e) { return []; }
}

// 3. APIBAY (TPB API)
async function searchAPIBay(query) {
    try {
        const { data } = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200`, { timeout: TIMEOUT });
        if(data[0]?.name === 'No results returned') return [];
        return data.map(i => ({
            title: i.name,
            magnet: `magnet:?xt=urn:btih:${i.info_hash}&dn=${encodeURIComponent(i.name)}`,
            size: (i.size / 1024 / 1024 / 1024).toFixed(2) + " GB",
            seeders: parseInt(i.seeders),
            source: "TPB"
        }));
    } catch (e) { return []; }
}

// MAIN AGGREGATOR
async function searchMagnet(query) {
    console.log(`🔍 Searching: ${query}`);
    
    // Esegui in parallelo con Promise.allSettled per non bloccare se uno fallisce
    const results = await Promise.allSettled([
        searchSolid(query),
        searchBitSearch(query),
        searchAPIBay(query)
    ]);

    let all = [];
    results.forEach(r => {
        if(r.status === 'fulfilled') all.push(...r.value);
    });

    // Deduplica per Hash
    const unique = new Map();
    all.forEach(t => {
        const hash = t.magnet.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toUpperCase();
        if(hash && !unique.has(hash)) unique.set(hash, t);
    });

    return Array.from(unique.values());
}

module.exports = { searchMagnet };
