const axios = require("axios");
const cheerio = require("cheerio");

// USER AGENT "Chrome" per ingannare i controlli base
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/json,application/xhtml+xml",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"
};

// --- UTILS ---
function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|MB|KB)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    if (match[2].toUpperCase().includes('G')) val *= 1024 * 1024 * 1024;
    else if (match[2].toUpperCase().includes('M')) val *= 1024 * 1024;
    return Math.round(val);
}

// --- 1. SOLID TORRENTS (JSON API - Vercel Friendly 100%) ---
async function searchSolid(query) {
    try {
        const { data } = await axios.get(`https://solidtorrents.to/api/v1/search`, {
            params: { q: query, category: 'Video', sort: 'seeders' },
            headers: HEADERS,
            timeout: 3500 // Timeout breve
        });
        
        if (!data.results) return [];
        return data.results.map(item => ({
            title: item.title,
            magnet: item.magnet,
            size: (item.size / 1073741824).toFixed(2) + " GB",
            seeders: item.seeders,
            source: "Solid"
        }));
    } catch (e) { return []; }
}

// --- 2. BITSEARCH (HTML Parsing - Molto permissivo) ---
async function searchBitSearch(query) {
    try {
        const { data } = await axios.get(`https://bitsearch.to/search`, {
            params: { q: query },
            headers: HEADERS,
            timeout: 4000
        });
        
        const $ = cheerio.load(data);
        const results = [];
        
        $('li.search-result').each((i, el) => {
            const title = $(el).find('h5.title a').text().trim();
            const magnet = $(el).find('a.dl-magnet').attr('href');
            const stats = $(el).find('.stats div');
            const size = $(stats).eq(1).text().trim();
            const seeders = parseInt($(stats).eq(2).text().trim()) || 0;
            
            if (title && magnet) {
                results.push({ title, magnet, size, seeders, source: "BitSearch" });
            }
        });
        return results;
    } catch (e) { return []; }
}

// --- 3. APIBAY (TPB Mirror JSON - Vercel Friendly) ---
async function searchAPIBay(query) {
    try {
        const { data } = await axios.get(`https://apibay.org/q.php`, {
            params: { q: query, cat: 200 },
            headers: HEADERS,
            timeout: 3500
        });
        if (data[0]?.name === 'No results returned') return [];
        
        return data.map(item => ({
            title: item.name,
            magnet: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}`,
            size: (item.size / 1073741824).toFixed(2) + " GB",
            seeders: parseInt(item.seeders),
            source: "TPB"
        }));
    } catch (e) { return []; }
}

// --- MAIN SEARCH ---
async function searchMagnet(title, year) {
    // Pulisci il titolo
    const cleanTitle = title.replace(/[:"']/g, "").replace(/\s+/g, " ").trim();
    // Aggiungi "ITA" alla query per forzare risultati italiani sui motori internazionali
    const queryIta = `${cleanTitle} ITA`;
    
    console.log(`🔍 Vercel Search: ${queryIta}`);

    // Esegui tutto in parallelo
    const promises = [
        searchSolid(queryIta),
        searchBitSearch(queryIta),
        searchAPIBay(queryIta)
    ];

    const results = await Promise.allSettled(promises);
    let all = [];
    results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });

    // Deduplica per Magnet Hash
    const unique = new Map();
    all.forEach(item => {
        const hash = item.magnet.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toUpperCase();
        if (hash && !unique.has(hash)) unique.set(hash, item);
    });

    return Array.from(unique.values());
}

module.exports = { searchMagnet };
