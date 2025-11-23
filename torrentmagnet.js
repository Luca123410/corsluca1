const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

// --- CONFIGURAZIONE ---
const TIMEOUT_MS = 15000; 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// --- URL BASE ---
const CORSARO_BASE_URL = "https://ilcorsaronero.link";
const KNABEN_BASE_URL = "https://knaben.org";
const UINDEX_BASE_URL = "https://uindex.org";
const APIBAY_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to"; 

// --- TRACKERS ---
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

// Regex ITA: Accetta ITA, ITALIAN, MULTI, DUAL (Case Insensitive)
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
    if (!magnet || typeof magnet !== 'string') return null;
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

function decodeHtmlEntities(text) {
    if (!text) return "";
    const entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
        '&nbsp;': ' ', '&#8217;': "'", '&#8220;': '"', '&#8221;': '"',
        '&#8211;': '–', '&#8212;': '—'
    };
    return text.replace(/&[#\w]+;/g, match => entities[match] || match);
}

/* ===========================================================
   🏴‍☠️ 1. IL CORSARO NERO (Cerca Titolo Puro)
   =========================================================== */
async function searchCorsaro(query) {
    try {
        const searchUrl = `${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT }
        });

        const $ = cheerio.load(data);
        const rows = $('tbody tr').toArray();
        const results = [];

        for (const row of rows.slice(0, 30)) {
            const titleEl = $(row).find('th a');
            const title = titleEl.text().trim();
            const url = titleEl.attr('href');
            const size = $(row).find('td').eq(3).text().trim();
            const seeds = parseInt($(row).find('td.text-green-500').text().trim()) || 0;

            if (!url) continue;

            try {
                const detailUrl = `${CORSARO_BASE_URL}${url}`;
                const detailRes = await axios.get(detailUrl, {
                    timeout: 4000,
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
   🚀 2. 1337x (Cerca Globale, Filtra ITA)
   =========================================================== */
async function search1337x(title, year) {
    const cleanTitle = cleanString(title);
    const query = year ? `${cleanTitle} ${year}` : cleanTitle;
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
            let nameLink = tds.eq(0).find("a[href^='/torrent/']").first();
            if (!nameLink.length) nameLink = tds.eq(0).find("a").eq(1);
            
            if (!nameLink.length) return;

            const name = nameLink.text().trim();
            const torrentPath = nameLink.attr("href");
            if (!torrentPath) return;

            // 🔥 FILTRO ITA
            if (!ITA_REGEX.test(name)) return;

            const seeders = parseInt(tds.eq(1).text().replace(/,/g, "")) || 0;
            const sizeText = tds.eq(4).text();
            
            let sizeBytes = 0;
            const sizeMatch = sizeText.match(/([\d.]+)\s*([A-Z]+)/i);
            if (sizeMatch) {
                const val = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                if (unit.includes('GB')) sizeBytes = val * 1024 * 1024 * 1024;
                else if (unit.includes('MB')) sizeBytes = val * 1024 * 1024;
            }

            candidates.set(torrentPath, { name, path: torrentPath, seeders, sizeBytes, size: sizeText });
        });

        const topCandidates = [...candidates.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 15);

        const magnets = await Promise.all(topCandidates.map(async c => {
            try {
                const detailUrl = BASE_1337X + c.path;
                const { data: detailData } = await axios.get(detailUrl, { timeout: 6000, headers });
                const $$ = cheerio.load(detailData);
                
                let magnet = $$("a[href^='magnet:']").first().attr("href");
                if (!magnet) {
                    const html = $$('body').html();
                    const match = html.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+/);
                    if (match) magnet = match[0];
                }

                if (!magnet) return null;
                const infoHash = extractInfoHash(magnet);
                if (!infoHash) return null;

                return {
                    title: c.name,
                    magnet: buildMagnet(infoHash, c.name),
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
   🌊 3. APIBAY (Cerca Globale, Filtra ITA)
   =========================================================== */
async function searchAPIBay(title, year) {
    try {
        const cleanTitle = cleanString(title);
        const query = year ? `${cleanTitle} ${year}` : cleanTitle;
        const categoryId = year ? 200 : 205; 
        
        const { data } = await axios.get(APIBAY_URL, {
            params: { q: query, cat: categoryId },
            timeout: TIMEOUT_MS
        });

        if (!Array.isArray(data) || !data.length || data[0].name === "No results returned") return [];

        return data.map(item => {
            if (!item.info_hash || item.info_hash === "0000000000000000000000000000000000000000") return null;
            
            // 🔥 FILTRO ITA
            if (!ITA_REGEX.test(item.name)) return null;

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
   🦉 4. KNABEN (Cerca Globale, Filtra ITA)
   =========================================================== */
async function searchKnaben(title, year) {
    try {
        const cleanTitle = cleanString(title);
        // Cerca "Titolo Anno" per massimizzare i risultati
        const query = year ? `${cleanTitle} ${year}` : cleanTitle;
        
        const url = `${KNABEN_BASE_URL}/search/${encodeURIComponent(query)}/0/1/seeders`;
        
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT }
        });

        const $ = cheerio.load(data);
        const results = [];

        $('table tbody tr').each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 5) return;

            const torrentTitle = $(cells[1]).find('a').first().text().trim();
            
            // 🔥 FILTRO ITA: Se non contiene ITA/Multi, scarta.
            if (!ITA_REGEX.test(torrentTitle)) return;

            const magnet = $(cells[1]).find('a[href^="magnet:"]').attr('href');
            const sizeStr = $(cells[2]).text().trim();
            const seeds = parseInt($(cells[4]).text().trim()) || 0;

            if (torrentTitle && magnet) {
                results.push({
                    title: torrentTitle, magnet, size: sizeStr, sizeBytes: parseSize(sizeStr),
                    seeders: seeds, source: 'Knaben', quality: extractQuality(torrentTitle)
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
   📊 5. UINDEX (Cerca ITA)
   =========================================================== */
async function searchUIndex(query) {
    try {
        const headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        };

        const url = `${UINDEX_BASE_URL}/search.php?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: headers
        });

        if (!data || typeof data !== 'string') return [];

        const rows = data.split(/<tr[^>]*>/gi).filter(r => r.includes('magnet:'));
        
        return rows.map(row => {
            try {
                const magnetMatch = row.match(/(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s<>]*)/i);
                if (!magnetMatch) return null;
                let magnetLink = decodeHtmlEntities(magnetMatch[1]);

                const cellRegex = /<td[^>]*>(.*?)<\/td>/gis;
                const cells = [];
                let cellMatch;
                while ((cellMatch = cellRegex.exec(row)) !== null) {
                    cells.push(cellMatch[1].trim());
                }

                if (cells.length < 2) return null;

                let title = "Unknown";
                const titleCell = cells[1]; 
                const titleMatch = titleCell.match(/<a[^>]*>([^<]+)<\/a>/i);
                if (titleMatch) {
                    title = titleMatch[1];
                } else {
                    title = titleCell.replace(/<[^>]+>/g, '').trim();
                }
                title = decodeHtmlEntities(title).trim();
                if (title.length < 3) return null;

                // 🔥 FILTRO ITA
                if (!ITA_REGEX.test(title)) return null;

                let sizeStr = "Unknown";
                if (cells.length > 2) {
                    const sizeMatch = cells[2].match(/([\d.,]+\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB))/i);
                    if (sizeMatch) sizeStr = sizeMatch[1].trim();
                }

                let seeders = 0;
                if (cells.length > 3) {
                    for(let i=3; i < cells.length; i++) {
                        const num = parseInt(cells[i].replace(/<[^>]+>/g, '').trim());
                        if (!isNaN(num) && cells[i].includes('green')) {
                            seeders = num;
                            break;
                        }
                    }
                    if (seeders === 0 && cells[4]) {
                         const s = parseInt(cells[4].replace(/<[^>]+>/g, ''));
                         if(!isNaN(s)) seeders = s;
                    }
                }

                return {
                    title, magnet: magnetLink, size: sizeStr, sizeBytes: parseSize(sizeStr),
                    seeders: seeders, source: 'UIndex', quality: extractQuality(title)
                };
            } catch (err) { return null; }
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
    
    // 1. Corsaro cerca "Titolo" (trova meglio se il titolo è pulito)
    const queryCorsaro = cleanTitle;
    
    // 2. UIndex cerca "Titolo ITA" (è specifico)
    const queryUIndex = `${cleanTitle} ITA`;

    // 3. Knaben/1337x/API cercano "Titolo Anno" (per trovare le release Multi)
    // Se è una serie, solo Titolo.
    const queryGlobal = year ? `${cleanTitle} ${year}` : cleanTitle;
    
    console.log(`\n🔍 [SEARCH] "${cleanTitle}" (${year})`);
    console.log(`   🏴‍☠️ Corsaro Query: "${queryCorsaro}"`);
    console.log(`   🇮🇹 UIndex Query: "${queryUIndex}"`);
    console.log(`   🌍 Global Query: "${queryGlobal}" (Filter: ITA/Multi)`);
    
    // --- FIX CORSARO SERIES LOGIC ---
    let corsaroQuery = cleanTitle;
    const seriesMatch = cleanTitle.match(/(.+?)\s+S(\d{1,2})/i); 
    if (seriesMatch) {
        const cleanName = seriesMatch[1].trim();
        const seasonNum = parseInt(seriesMatch[2]);
        corsaroQuery = `${cleanName} Stagione ${seasonNum}`;
        console.log(`   🏴‍☠️ Corsaro Series: "${corsaroQuery}"`);
    }
    // -------------------------------

    const promises = [
        searchCorsaro(corsaroQuery),        
        search1337x(cleanTitle, year),  // Passiamo cleanTitle, la funzione gestisce queryGlobal
        searchAPIBay(cleanTitle, year), 
        searchKnaben(cleanTitle, year), // Passiamo cleanTitle, la funzione gestisce queryGlobal
        searchUIndex(queryUIndex)       // Passiamo query ITA specifica
    ];

    const resultsArray = await Promise.allSettled(promises);
    
    let allResults = [];
    resultsArray.forEach(res => {
        if (res.status === 'fulfilled') allResults.push(...res.value);
    });

    // --- DEDUPLICAZIONE & FILTRO FINALE ---
    const uniqueMap = new Map();
    
    allResults.forEach(item => {
        // Filtro di sicurezza finale (Dovrebbe essere già stato fatto, ma double check)
        if (!ITA_REGEX.test(item.title)) return;

        const hash = extractInfoHash(item.magnet);
        if (!hash) return;

        // 🔥 CAMPI OBBLIGATORI PER STREMIO
        item.infoHash = hash; 
        item.magnetLink = item.magnet; 

        if (!uniqueMap.has(hash)) {
            uniqueMap.set(hash, item);
        } else {
            const existing = uniqueMap.get(hash);
            // Prioritizziamo sempre Corsaro/UIndex
            if (item.source === 'CorsaroNero' || item.source === 'UIndex') {
                uniqueMap.set(hash, item);
            } else if (existing.source !== 'CorsaroNero' && existing.source !== 'UIndex' && item.seeders > existing.seeders) {
                uniqueMap.set(hash, item);
            }
        }
    });

    const uniqueResults = [...uniqueMap.values()];

    // --- ORDINAMENTO ---
    uniqueResults.sort((a, b) => {
        const isCorsaroA = a.source === 'CorsaroNero';
        const isCorsaroB = b.source === 'CorsaroNero';
        
        if (isCorsaroA && !isCorsaroB) return -1;
        if (!isCorsaroA && isCorsaroB) return 1;

        if (b.seeders !== a.seeders) return b.seeders - a.seeders;

        const qScore = (q) => (q === '4k' ? 3 : q === '1080p' ? 2 : 1);
        return qScore(b.quality) - qScore(a.quality);
    });

    console.log(`✅ Totale Risultati ITA: ${uniqueResults.length}`);
    
    const sources = uniqueResults.reduce((acc, curr) => {
        acc[curr.source] = (acc[curr.source] || 0) + 1;
        return acc;
    }, {});
    console.log(`📊 Fonti: ${JSON.stringify(sources)}`);

    return uniqueResults.slice(0, 80); 
}

module.exports = { searchMagnet };
