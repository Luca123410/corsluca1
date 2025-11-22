const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

// --- CONFIGURAZIONE ---
const TIMEOUT_MS = 15000; // 15s per gestire tutto il traffico

// --- UA ROTATION ---
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// --- URL BASE ---
const CORSARO_BASE_URL = "https://ilcorsaronero.link";
const APIBAY_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337xx.to"; 
const KNABEN_BASE_URL = "https://knaben.org";
const TGX_BASE_URL = "https://torrentgalaxy.to"; 
const UINDEX_BASE_URL = "https://uindex.org"; // <--- ECCOLO!

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://9.rarbg.com:2810/announce",
    "udp://opentracker.i2p.rocks:6969/announce"
];

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|DTS[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

// --- UTILITIES ---
function cleanString(str) {
    return str.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toUpperCase() : null;
}

function extractQuality(title) {
    const t = title.toLowerCase();
    if (t.includes('2160p') || t.includes('4k')) return '4k';
    if (t.includes('1080p')) return '1080p';
    if (t.includes('720p')) return '720p';
    if (t.includes('dvdrip') || t.includes('sd')) return 'SD';
    return 'Unknown';
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|GiB|MB|MiB)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit.includes('G')) val *= 1024 * 1024 * 1024;
    if (unit.includes('M')) val *= 1024 * 1024;
    return Math.round(val);
}

function buildMagnet(infoHash, name) {
    const trackersStr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackersStr}`;
}

/* ===========================================================
   1. IL CORSARO NERO
   =========================================================== */
async function searchCorsaro(query) {
    try {
        const { data } = await axios.get(`${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': getRandomUA() }
        });

        const $ = cheerio.load(data);
        const results = [];

        for (const row of $('tbody tr').slice(0, 8)) {
            const titleEl = $(row).find('th a');
            const title = titleEl.text().trim();
            const url = titleEl.attr('href');
            const size = $(row).find('td').eq(3).text().trim();
            const seeds = parseInt($(row).find('td.text-green-500').text().trim()) || 0;

            if (!url) continue;
            try {
                const detailRes = await axios.get(`${CORSARO_BASE_URL}${url}`, {
                    timeout: 5000,
                    headers: { 'User-Agent': getRandomUA() }
                });
                const $$ = cheerio.load(detailRes.data);
                let magnet = $$('a[href^="magnet:?"]').attr('href') || $$("div.w-full:nth-child(2) a").attr('href');
                
                if (magnet) {
                    results.push({
                        title, magnet, size: size || 'Unknown', sizeBytes: parseSize(size),
                        seeders: seeds, source: 'CorsaroNero', quality: extractQuality(title)
                    });
                }
            } catch (e) { continue; }
        }
        return results;
    } catch (e) { return []; }
}

/* ===========================================================
   2. 1337x (Parallel Search)
   =========================================================== */
async function search1337x(title, year) {
    let cleanTitle = cleanString(title);
    if (year) cleanTitle = cleanTitle.replace(year, '').trim();
    const baseQuery = `${cleanTitle} ${year || ''}`.trim();

    const italianKeywords = ["ITA", "Italian", "Italiano", "MULTI", "DUAL", "CiNEFiLE"]; 
    const queries = [ baseQuery, ...italianKeywords.map(k => `${baseQuery} ${k}`) ];
    const headers = { "User-Agent": getRandomUA() };
    const candidates = new Map();

    const searchPromises = queries.map(async (q) => {
        try {
            const url = `${BASE_1337X}/category-search/${encodeURIComponent(q)}/Movies/1/`;
            const { data } = await axios.get(url, { timeout: 8000, headers }).catch(() => ({ data: "" }));
            if (!data) return;

            const $ = cheerio.load(data);
            $("table.table-list tbody tr").each((_, row) => {
                const tds = $(row).find("td");
                const nameLink = tds.eq(0).find("a").eq(1);
                if (!nameLink.length) return;

                const name = nameLink.text().trim();
                if (!ITA_REGEX.test(name)) return;
                if (year && !name.includes(year)) return;

                const torrentPath = nameLink.attr("href");
                if (!torrentPath) return;

                const seeders = parseInt(tds.eq(1).text().replace(/,/g, "")) || 0;
                const sizeText = tds.eq(4).text();
                
                if (!candidates.has(torrentPath) || seeders > candidates.get(torrentPath).seeders) {
                    candidates.set(torrentPath, {
                        name, path: torrentPath, seeders,
                        size: sizeText, sizeBytes: parseSize(sizeText)
                    });
                }
            });
        } catch(e) {}
    });

    await Promise.all(searchPromises);

    const sortedCandidates = [...candidates.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 5);
    
    const magnets = await Promise.all(sortedCandidates.map(async c => {
        try {
            const { data } = await axios.get(BASE_1337X + c.path, { timeout: 5000, headers });
            const $ = cheerio.load(data);
            const magnet = $("a[href^='magnet:']").first().attr("href");
            if (!magnet) return null;

            const hash = extractInfoHash(magnet);
            if (!hash) return null;

            return {
                title: c.name, magnet: buildMagnet(hash, c.name),
                size: c.size, sizeBytes: c.sizeBytes,
                seeders: c.seeders, source: "1337x", quality: extractQuality(c.name)
            };
        } catch (e) { return null; }
    }));

    return magnets.filter(Boolean);
}

/* ===========================================================
   3. UINDEX (REINSERITO!)
   =========================================================== */
async function searchUIndex(query) {
    try {
        const { data } = await axios.get(`${UINDEX_BASE_URL}/search.php?search=${encodeURIComponent(query)}`, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': getRandomUA() }
        });

        const rows = data.split(/<tr[^>]*>/gi).filter(r => r.includes('magnet:?') && r.includes('<td'));
        
        return rows.map(row => {
            const magnetMatch = row.match(/href=["'](magnet:\?xt=urn:btih:[^"']+)["']/i);
            if (!magnetMatch) return null;
            
            const titleMatch = row.match(/<a[^>]*>([^<]+)<\/a>/i);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : "Unknown";
            const sizeMatch = row.match(/([\d.,]+\s*[A-Z]+)/i);
            const size = sizeMatch ? sizeMatch[1] : "Unknown";

            return {
                title, magnet: magnetMatch[1], size, sizeBytes: parseSize(size),
                seeders: 0, source: 'UIndex', quality: extractQuality(title)
            };
        }).filter(Boolean);
    } catch (e) { return []; }
}

/* ===========================================================
   4. APIBAY (TPB)
   =========================================================== */
async function searchAPIBay(title, year) {
    try {
        const query = `${cleanString(title)} ITA`;
        const { data } = await axios.get(APIBAY_URL, {
            params: { q: query, cat: 200 },
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': getRandomUA() }
        });

        if (!Array.isArray(data) || !data.length || data[0].name === "No results returned") return [];

        return data.map(item => {
            if (!item.info_hash || item.info_hash === "0000000000000000000000000000000000000000") return null;
            const sizeBytes = parseInt(item.size);
            return {
                title: item.name,
                magnet: buildMagnet(item.info_hash, item.name),
                size: (sizeBytes / 1073741824).toFixed(2) + " GB",
                sizeBytes: sizeBytes,
                seeders: parseInt(item.seeders),
                source: 'Apibay',
                quality: extractQuality(item.name)
            };
        }).filter(Boolean);
    } catch (e) { return []; }
}

/* ===========================================================
   5. KNABEN & TGx
   =========================================================== */
async function searchKnaben(query) {
    try {
        const url = `${KNABEN_BASE_URL}/search/${encodeURIComponent(cleanString(query))}/0/1/seeders`;
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            httpsAgent: httpsAgent,
            headers: { 'User-Agent': getRandomUA() }
        });
        const $ = cheerio.load(data);
        const results = [];
        $('table tbody tr').each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 5) return;
            const title = $(cells[1]).find('a').first().text().trim();
            const magnet = $(cells[1]).find('a[href^="magnet:"]').attr('href');
            const sizeStr = $(cells[2]).text().trim();
            const seeds = parseInt($(cells[4]).text().trim()) || 0;
            if (title && magnet) {
                results.push({
                    title, magnet, size: sizeStr, sizeBytes: parseSize(sizeStr),
                    seeders: seeds, source: 'Knaben', quality: extractQuality(title)
                });
            }
        });
        return results;
    } catch (e) { return []; }
}

async function searchTGx(query) {
    try {
        const url = `${TGX_BASE_URL}/torrents.php?search=${encodeURIComponent(query)}&sort=seeders&order=desc`;
        const { data } = await axios.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': getRandomUA() } });
        const $ = cheerio.load(data);
        const results = [];
        $('div.tgxtable div.tgxtablerow').each((_, row) => {
            const cells = $(row).find('div.tgxtablecell');
            if (cells.length < 5) return;
            const title = $(cells[3]).find('a').first().text().trim();
            const magnet = $(cells[4]).find('a[href^="magnet:"]').attr('href');
            const sizeStr = $(cells[7]).text().trim();
            const seeds = parseInt($(cells[10]).find('span font').text()) || 0;
            if (magnet) {
                results.push({ title, magnet, size: sizeStr, sizeBytes: parseSize(sizeStr), seeders: seeds, source: 'TGx', quality: extractQuality(title) });
            }
        });
        return results.slice(0, 5);
    } catch (e) { return []; }
}

/* ===========================================================
   🔴 MAIN AGGREGATOR
   =========================================================== */
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    const fullQuery = `${cleanTitle} ${year || ''}`.trim();
    const queryIta = `${cleanTitle} ITA`; // Per UIndex

    console.log(`\n🔍 [PRIV] "${cleanTitle}" (${year})`);

    const promises = [
        searchCorsaro(cleanTitle),      
        search1337x(title, year),       
        searchAPIBay(title, year),
        searchKnaben(fullQuery),
        searchTGx(fullQuery),
        searchUIndex(queryIta) 
    ];

    const resultsArray = await Promise.allSettled(promises);
    let allResults = [];
    resultsArray.forEach(res => {
        if (res.status === 'fulfilled') allResults.push(...res.value);
    });

    // Deduplicazione
    const uniqueMap = new Map();
    allResults.forEach(item => {
        const hash = extractInfoHash(item.magnet);
        if (hash) {
            if (!uniqueMap.has(hash) || (item.source === 'CorsaroNero')) {
                uniqueMap.set(hash, item);
            }
        }
    });

    return [...uniqueMap.values()];
}

module.exports = { searchMagnet };
