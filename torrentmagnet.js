const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

// --- CONFIGURAZIONE ---
const TIMEOUT_MS = 15000; 
const USER_AGENT_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- URL BASE ---
const CORSARO_BASE_URL = "https://ilcorsaronero.link";
const KNABEN_BASE_URL = "https://knaben.org"; 
const UINDEX_BASE_URL = "https://uindex.org";
const API_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to";

// --- TRACKERS LIST ---
const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.ds.is:6969/announce",
    "udp://retracker.lanta-net.ru:2710/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://ipv4.tracker.harry.lu:80/announce"
];

// Regex per intercettare Italiano
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|DTS[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

// --- UTILITIES ---
function cleanString(str) {
    return str
        .replace(/[:"'’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toUpperCase() : null;
}

function extractQuality(title) {
    if (!title) return 'Unknown';
    const t = title.toLowerCase();
    if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4k';
    if (t.includes('1080p') || t.includes('fhd')) return '1080p';
    if (t.includes('720p') || t.includes('hd')) return '720p';
    if (t.includes('480p') || t.includes('sd')) return 'SD';
    if (t.includes('dvdrip')) return 'DVD';
    if (t.includes('cam') || t.includes('ts')) return 'CAM';
    return 'Unknown';
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|MB|KB|B)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit === 'GB') val *= 1024 * 1024 * 1024;
    if (unit === 'MB') val *= 1024 * 1024;
    if (unit === 'KB') val *= 1024;
    return Math.round(val);
}

// Helper per creare magnet link dai tracker
function constructMagnet(infoHash, name) {
    const trackersStr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackersStr}`;
}

/* ===========================================================
   🏴‍☠️ IL CORSARO NERO SEARCH
   =========================================================== */
async function searchCorsaro(query) {
    try {
        const searchUrl = `${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT_DESKTOP }
        });

        const $ = cheerio.load(data);
        const rows = $('tbody tr').toArray();
        const results = [];

        for (const row of rows.slice(0, 8)) { 
            const titleEl = $(row).find('th a');
            const title = titleEl.text().trim();
            const url = titleEl.attr('href');
            const size = $(row).find('td').eq(3).text().trim();
            const seeds = parseInt($(row).find('td.text-green-500').text().trim()) || 0;

            if (!url) continue;

            try {
                const detailUrl = `${CORSARO_BASE_URL}${url}`;
                const detailRes = await axios.get(detailUrl, { 
                    timeout: 6000,
                    headers: { 'User-Agent': USER_AGENT_DESKTOP }
                });
                const $$ = cheerio.load(detailRes.data);
                
                let magnet = $$('a[href^="magnet:?"]').attr('href');
                if (!magnet) magnet = $$("div.w-full:nth-child(2) a").attr('href');

                if (magnet) {
                    results.push({
                        title,
                        magnet,
                        size: size || 'Unknown',
                        sizeBytes: parseSize(size),
                        seeders: seeds,
                        source: 'CorsaroNero',
                        quality: extractQuality(title)
                    });
                }
            } catch (e) { continue; }
        }
        return results;
    } catch (e) {
        console.error("❌ Corsaro Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🦉 KNABEN SEARCH
   =========================================================== */
async function searchKnaben(query) {
    try {
        const cleanQuery = cleanString(query);
        const url = `${KNABEN_BASE_URL}/search/${encodeURIComponent(cleanQuery)}/0/1/seeders`;
        
        const ignoreSSL = new https.Agent({ rejectUnauthorized: false });
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            httpsAgent: ignoreSSL,
            headers: {
                'User-Agent': USER_AGENT_DESKTOP,
                'Accept': 'text/html',
                'Referer': 'https://knaben.org/'
            }
        });

        const $ = cheerio.load(data);
        const rows = $('table tbody tr').toArray();
        const results = [];

        rows.forEach(row => {
            const cells = $(row).find('td');
            if (cells.length < 5) return;

            const titleLink = $(cells[1]).find('a').first();
            const title = titleLink.text().trim();
            const magnet = $(cells[1]).find('a[href^="magnet:"]').attr('href');
            const sizeStr = $(cells[2]).text().trim();
            const seeds = parseInt($(cells[4]).text().trim()) || 0;

            if (title && magnet) {
                results.push({
                    title,
                    magnet,
                    size: sizeStr,
                    sizeBytes: parseSize(sizeStr),
                    seeders: seeds,
                    source: 'Knaben',
                    quality: extractQuality(title)
                });
            }
        });
        return results;
    } catch (e) {
        console.error("🦉 Knaben Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🌊 APIBAY (ThePirateBay) SEARCH
   =========================================================== */
async function searchAPIBay(query) {
    try {
        // APIBay non richiede parsing HTML, restituisce JSON
        const url = `${API_URL}?q=${encodeURIComponent(query)}`;
        console.log(`🌊 APIBay URL: ${url}`);

        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT_DESKTOP }
        });

        if (!data || data[0]?.name === 'No results returned') return [];

        return data.map(item => {
            const sizeBytes = parseInt(item.size);
            const magnet = constructMagnet(item.info_hash, item.name);
            
            return {
                title: item.name,
                magnet: magnet,
                size: (sizeBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB', // Formattazione grezza
                sizeBytes: sizeBytes,
                seeders: parseInt(item.seeders),
                source: 'APIBay',
                quality: extractQuality(item.name)
            };
        });

    } catch (e) {
        console.error("❌ APIBay Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🚀 1337x SEARCH (2-Step Scraping)
   =========================================================== */
async function search1337x(query) {
    try {
        // Step 1: Cerca ordinando per seeders
        const searchUrl = `${BASE_1337X}/sort-search/${encodeURIComponent(query)}/seeders/desc/1/`;
        console.log(`🚀 1337x Search: ${searchUrl}`);

        const { data } = await axios.get(searchUrl, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT_DESKTOP }
        });

        const $ = cheerio.load(data);
        const rows = $('table.table-list tr').toArray();
        
        // Prendiamo solo i primi 5 risultati per evitare troppe richieste secondarie
        const topRows = rows.slice(0, 5);
        const detailPromises = [];

        topRows.forEach(row => {
            const link = $(row).find('.name a[href^="/torrent/"]').attr('href');
            if (link) {
                const detailUrl = `${BASE_1337X}${link}`;
                detailPromises.push(
                    axios.get(detailUrl, { 
                        timeout: 5000,
                        headers: { 'User-Agent': USER_AGENT_DESKTOP }
                    }).catch(() => null) // Ignora errori singoli
                );
            }
        });

        const detailResponses = await Promise.all(detailPromises);
        const results = [];

        detailResponses.forEach(res => {
            if (!res || !res.data) return;
            const $$ = cheerio.load(res.data);
            
            const title = $$('h1').text().trim();
            const magnet = $$('a[href^="magnet:?"]').attr('href');
            const sizeStr = $$('ul.list li span:contains("Total size")').next().text().trim();
            const seeds = parseInt($$('ul.list li span:contains("Seeders")').next().text().trim()) || 0;

            if (title && magnet) {
                results.push({
                    title,
                    magnet,
                    size: sizeStr,
                    sizeBytes: parseSize(sizeStr),
                    seeders: seeds,
                    source: '1337x',
                    quality: extractQuality(title)
                });
            }
        });

        return results;

    } catch (e) {
        console.error("❌ 1337x Error (Often Cloudflare blocks this):", e.message);
        return [];
    }
}

/* ===========================================================
   📊 UINDEX SEARCH
   =========================================================== */
async function searchUIndex(query) {
    try {
        const url = `${UINDEX_BASE_URL}/search.php?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT_DESKTOP }
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
                title: title,
                magnet: magnetMatch[1],
                size: size,
                sizeBytes: parseSize(size),
                seeders: 0, 
                source: 'UIndex',
                quality: extractQuality(title)
            };
        }).filter(Boolean);

    } catch (e) {
        console.error("❌ UIndex Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🔴 SEARCH MAGNET (MAIN FUNCTION)
   =========================================================== */
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    const queryIta = `${cleanTitle} ITA`;
    
    console.log(`\n🔍 [SEARCH] "${cleanTitle}" (${year})`);

    const promises = [
        searchCorsaro(cleanTitle),
        searchUIndex(queryIta),
        searchKnaben(cleanTitle), // Cerca titolo originale (trova ita e eng)
        searchAPIBay(cleanTitle), // NUOVO: ThePirateBay
        search1337x(cleanTitle)   // NUOVO: 1337x
    ];

    const resultsArray = await Promise.allSettled(promises);
    
    let allResults = [];
    resultsArray.forEach(res => {
        if (res.status === 'fulfilled') allResults.push(...res.value);
    });

    // --- DEDUPLICAZIONE ---
    const uniqueMap = new Map();
    
    allResults.forEach(item => {
        const hash = extractInfoHash(item.magnet);
        if (!hash) return;

        if (!uniqueMap.has(hash)) {
            uniqueMap.set(hash, item);
        } else {
            const existing = uniqueMap.get(hash);
            // Priorità Sources: Corsaro > 1337x > Knaben/APIBay > UIndex
            if (item.source === 'CorsaroNero') {
                uniqueMap.set(hash, item); 
            } else if (item.source === '1337x' && existing.source !== 'CorsaroNero') {
                uniqueMap.set(hash, item);
            } else if (item.seeders > existing.seeders && existing.source !== 'CorsaroNero') {
                // Se la fonte nuova ha più seeder (e non stiamo sovrascrivendo Corsaro), aggiorna
                uniqueMap.set(hash, item);
            }
        }
    });

    const uniqueResults = [...uniqueMap.values()];

    // --- ORDINAMENTO (Smart Ranking) ---
    uniqueResults.sort((a, b) => {
        const isCorsaroA = a.source === 'CorsaroNero';
        const isCorsaroB = b.source === 'CorsaroNero';
        
        // 1. Corsaro SEMPRE primo (perché italiano)
        if (isCorsaroA && !isCorsaroB) return -1;
        if (!isCorsaroA && isCorsaroB) return 1;

        // 2. Qualità (4K > 1080p > altro)
        const qScore = (q) => (q === '4k' ? 3 : q === '1080p' ? 2 : 1);
        const qualityDiff = qScore(b.quality) - qScore(a.quality);
        if (qualityDiff !== 0) return qualityDiff;

        // 3. Seeders (Importante per fonti internazionali come APIBay/1337x)
        if (b.seeders !== a.seeders) return b.seeders - a.seeders;

        // 4. Dimensione
        return b.sizeBytes - a.sizeBytes;
    });

    console.log(`✅ Found ${uniqueResults.length} unique results.`);
    
    // Log Sources
    const sources = uniqueResults.reduce((acc, curr) => {
        acc[curr.source] = (acc[curr.source] || 0) + 1;
        return acc;
    }, {});
    console.log(`📊 Sources: ${JSON.stringify(sources)}`);

    return uniqueResults.slice(0, 40); 
}

module.exports = { searchMagnet };
