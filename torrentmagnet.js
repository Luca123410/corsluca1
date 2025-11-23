const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

// --- CONFIGURAZIONE ---
const TIMEOUT_MS = 10000; // Timeout bilanciato
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

// --- URL BASE ---
const CORSARO_BASE_URL = "https://ilcorsaronero.link";
const KNABEN_BASE_URL = "https://knaben.org";
const UINDEX_BASE_URL = "https://uindex.org";
const APIBAY_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to"; 

// --- TRACKERS AGGIORNATI ---
const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://9.rarbg.com:2810/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "udp://vibe.community:6969/announce",
    "https://opentracker.i2p.rocks:443/announce",
    "udp://tracker.tiny-vps.com:6969/announce"
];

// Regex ITA Potenziata
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
    const match = sizeStr.match(/([\d.,]+)\s*(GB|GiB|MB|MiB|KB|KiB)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit.includes('G')) val *= 1024 * 1024 * 1024;
    if (unit.includes('M')) val *= 1024 * 1024;
    if (unit.includes('K')) val *= 1024;
    return Math.round(val);
}

function buildMagnet(infoHash, name) {
    const trackersStr = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackersStr}`;
}

/* ===========================================================
   🏴‍☠️ 1. IL CORSARO NERO (Re della ricerca ITA)
   =========================================================== */
async function searchCorsaro(query) {
    try {
        // Corsaro non ama le query troppo lunghe o complesse
        const searchUrl = `${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT }
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
                    timeout: 5000, // Timeout breve per i dettagli
                    headers: { 'User-Agent': USER_AGENT }
                });
                const $$ = cheerio.load(detailRes.data);
                
                let magnet = $$('a[href^="magnet:?"]').attr('href');
                if (!magnet) magnet = $$("div.w-full:nth-child(2) a").attr('href');

                if (magnet) {
                    results.push({
                        title, magnet, size: size || 'Unknown', sizeBytes: parseSize(size),
                        seeders: seeds, source: 'CorsaroNero', quality: extractQuality(title)
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
   🚀 2. 1337x
   =========================================================== */
async function search1337x(title, year) {
    const cleanTitle = cleanString(title);
    const query = `${cleanTitle} ITA`; 
    const candidates = new Map();
    const headers = { "User-Agent": USER_AGENT };

    try {
        const categoryPath = year ? 'Movies' : 'TV'; 
        const url = `${BASE_1337X}/category-search/${encodeURIComponent(query)}/${categoryPath}/1/`;

        const { data } = await axios.get(url, { timeout: TIMEOUT_MS, headers }).catch(() => ({ data: "" }));
        if (!data) return [];

        const $ = cheerio.load(data);

        $("table.table-list tbody tr").each((_, row) => {
            const tds = $(row).find("td");
            const nameLink = tds.eq(0).find("a").eq(1);
            if (!nameLink.length) return;

            const name = nameLink.text().trim();
            if (!ITA_REGEX.test(name)) return;

            const torrentPath = nameLink.attr("href");
            if (!torrentPath) return;

            if (year) {
                const y = parseInt(year);
                if (!name.includes(y.toString()) && !name.includes((y-1).toString()) && !name.includes((y+1).toString())) return;
            }

            const seeders = parseInt(tds.eq(1).text().replace(/,/g, "")) || 0;
            const sizeText = tds.eq(4).text();
            
            let sizeBytes = 0;
            if (sizeText.includes("GB")) sizeBytes = parseFloat(sizeText) * 1073741824;
            else if (sizeText.includes("MB")) sizeBytes = parseFloat(sizeText) * 1048576;

            candidates.set(torrentPath, { name, path: torrentPath, seeders, sizeBytes, size: sizeText });
        });

        const topCandidates = [...candidates.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 5);

        const magnets = await Promise.all(topCandidates.map(async c => {
            try {
                const detailUrl = BASE_1337X + c.path;
                const { data: detailData } = await axios.get(detailUrl, { timeout: 6000, headers });
                const $$ = cheerio.load(detailData);
                
                const magnet = $$("a[href^='magnet:']").first().attr("href");
                if (!magnet) return null;

                const m = magnet.match(/btih:([A-F0-9]{40})/i);
                const hash = m ? m[1].toUpperCase() : null;
                if (!hash) return null;

                return {
                    title: c.name,
                    magnet: buildMagnet(hash, c.name),
                    size: c.size,
                    sizeBytes: c.sizeBytes,
                    seeders: c.seeders,
                    source: "1337x",
                    quality: extractQuality(c.name)
                };
            } catch (e) { return null; }
        }));

        return magnets.filter(Boolean);
    } catch (e) {
        console.error("❌ 1337x Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🌊 3. APIBAY / TPB
   =========================================================== */
async function searchAPIBay(title, year) {
    try {
        const cleanTitle = cleanString(title);
        const query = `${cleanTitle} ITA`;
        const categoryId = year ? 200 : 205; 
        
        const { data } = await axios.get(APIBAY_URL, {
            params: { q: query, cat: categoryId },
            timeout: TIMEOUT_MS
        });

        if (!Array.isArray(data) || !data.length || data[0].name === "No results returned") return [];

        return data.map(item => {
            if (!item.info_hash || item.info_hash === "0000000000000000000000000000000000000000") return null;
            if (!ITA_REGEX.test(item.name)) return null;

            if (year) {
                const y = parseInt(year);
                if (!item.name.includes(y.toString()) && !item.name.includes((y-1).toString()) && !item.name.includes((y+1).toString())) return null;
            }

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
    } catch (e) {
        console.error("❌ APIBay Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🦉 4. KNABEN
   =========================================================== */
async function searchKnaben(query) {
    try {
        const cleanQuery = cleanString(query);
        const url = `${KNABEN_BASE_URL}/search/${encodeURIComponent(cleanQuery)}/0/1/seeders`;
        
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT }
        });

        const $ = cheerio.load(data);
        const results = [];

        $('table tbody tr').each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 5) return;

            const title = $(cells[1]).find('a').first().text().trim();
            if (!ITA_REGEX.test(title)) return;

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
    } catch (e) {
        console.error("❌ Knaben Error:", e.message);
        return [];
    }
}

/* ===========================================================
   📊 5. UINDEX
   =========================================================== */
async function searchUIndex(query) {
    try {
        const url = `${UINDEX_BASE_URL}/search.php?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT }
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
    } catch (e) {
        console.error("❌ UIndex Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🔴 MAIN SEARCH AGGREGATOR
   =========================================================== */
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    const queryIta = `${cleanTitle} ITA`;
    
    console.log(`\n🔍 [ALL-IN-ONE SEARCH] "${cleanTitle}" (${year})`);
    
    // --- FIX CORSARO SERIES LOGIC ---
    // Corsaro non trova "S01E01", ma trova "Stagione 1".
    // Creiamo una query specifica solo per Corsaro se è una serie TV.
    let corsaroQuery = cleanTitle;
    const seriesMatch = cleanTitle.match(/(.+?)\s+S(\d{1,2})/i); // Cattura "Titolo Sxx"

    if (seriesMatch) {
        // Trasforma "Gomorra S01E01" in "Gomorra Stagione 1"
        const cleanName = seriesMatch[1].trim();
        const seasonNum = parseInt(seriesMatch[2]);
        corsaroQuery = `${cleanName} Stagione ${seasonNum}`;
        console.log(`🇮🇹 Corsaro Optimized Query: "${corsaroQuery}"`);
    }
    // -------------------------------

    console.log(`📡 Sources: Corsaro, 1337x, APIBay, Knaben, UIndex`);

    const promises = [
        searchCorsaro(corsaroQuery),        // <--- Query modificata (Stagione X)
        search1337x(cleanTitle, year),      // Query standard (SxxExx)
        searchAPIBay(cleanTitle, year),     // Query standard (SxxExx)
        searchKnaben(cleanTitle),           // Query standard
        searchUIndex(queryIta)              // Query standard
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
            
            // Priorità:
            // 1. Corsaro Nero (perché è nativo italiano)
            if (item.source === 'CorsaroNero') {
                uniqueMap.set(hash, item);
            } 
            // 2. Chi ha più seeders
            else if (existing.source !== 'CorsaroNero' && item.seeders > existing.seeders) {
                uniqueMap.set(hash, item);
            }
        }
    });

    const uniqueResults = [...uniqueMap.values()];

    // --- ORDINAMENTO ---
    uniqueResults.sort((a, b) => {
        const isCorsaroA = a.source === 'CorsaroNero';
        const isCorsaroB = b.source === 'CorsaroNero';
        
        // Corsaro sempre per primo
        if (isCorsaroA && !isCorsaroB) return -1;
        if (!isCorsaroA && isCorsaroB) return 1;

        // Poi per Seeders
        if (b.seeders !== a.seeders) return b.seeders - a.seeders;

        // Poi per Qualità
        const qScore = (q) => (q === '4k' ? 3 : q === '1080p' ? 2 : 1);
        return qScore(b.quality) - qScore(a.quality);
    });

    console.log(`✅ Totale Risultati Unici: ${uniqueResults.length}`);
    
    const sources = uniqueResults.reduce((acc, curr) => {
        acc[curr.source] = (acc[curr.source] || 0) + 1;
        return acc;
    }, {});
    console.log(`📊 Distribuzione Fonti: ${JSON.stringify(sources)}`);

    return uniqueResults.slice(0, 40); 
}

module.exports = { searchMagnet };
