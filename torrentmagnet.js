const axios = require("axios");
const cheerio = require("cheerio");

// --- CONFIGURAZIONE ---
const TIMEOUT_GLOBAL = 15000; // Tempo totale massimo
const TIMEOUT_SOURCE = 6000;  // Tempo massimo per singola fonte (ridotto per velocità)
const MAX_CORSARO_RESULTS = 15; // Analizza max 15 risultati per non sovraccaricare

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
    return 'SD';
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|GiB|MB|MiB|KB|KiB)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit.includes('G')) val *= 1024 * 1024 * 1024;
    else if (unit.includes('M')) val *= 1024 * 1024;
    else if (unit.includes('K')) val *= 1024;
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
   🏴‍☠️ 1. IL CORSARO NERO (Parallelizzato per non bloccare)
   =========================================================== */
async function searchCorsaro(query) {
    try {
        const searchUrl = `${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`;
        // Timeout ridotto per la prima connessione
        const { data } = await axios.get(searchUrl, {
            timeout: 5000, 
            headers: { 'User-Agent': USER_AGENT }
        });

        const $ = cheerio.load(data);
        const rows = $('tbody tr').toArray();

        // ⚠️ Limitiamo a 15 risultati e usiamo Promise.all per fare le richieste INSIEME
        // Questo è il trucco per non farsi bloccare da Stremio
        const topRows = rows.slice(0, MAX_CORSARO_RESULTS);

        const promises = topRows.map(async (row) => {
            try {
                const titleEl = $(row).find('a.tab'); // Selettore standard
                let title = titleEl.text().trim();
                let url = titleEl.attr('href');
                
                // Fallback selettore
                if (!url) {
                    const altEl = $(row).find('a[href^="/torrent/"]');
                    title = altEl.text().trim();
                    url = altEl.attr('href');
                }

                if (!url) return null;

                const size = $(row).find('td').eq(3).text().trim();
                let seeds = parseInt($(row).find('td').eq(5).text().trim()) || 0;
                if (seeds === 0) seeds = parseInt($(row).find('.text-green-500').text().trim()) || 0;

                // Richiesta dettaglio (Magnet)
                const detailUrl = `${CORSARO_BASE_URL}${url}`;
                const detailRes = await axios.get(detailUrl, {
                    timeout: 4000, // Timeout breve per ogni pagina
                    headers: { 'User-Agent': USER_AGENT }
                });
                
                const $$ = cheerio.load(detailRes.data);
                let magnet = $$('a[href^="magnet:?"]').attr('href');
                if (!magnet) magnet = $$("div.w-full:nth-child(2) a").attr('href');

                if (magnet) {
                    return {
                        title, magnet, size: size || 'Unknown', sizeBytes: parseSize(size),
                        seeders: seeds, source: 'CorsaroNero', quality: extractQuality(title)
                    };
                }
            } catch (e) { return null; } // Se fallisce una riga, la ignoriamo e andiamo avanti
        });

        const results = await Promise.all(promises);
        return results.filter(Boolean);

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
    const query = year ? `${cleanTitle} ${year}` : cleanTitle;
    const candidates = new Map();
    const headers = { "User-Agent": USER_AGENT };

    try {
        const categoryPath = year ? 'Movies' : 'TV'; 
        const url = `${BASE_1337X}/category-search/${encodeURIComponent(query)}/${categoryPath}/1/`;

        const { data } = await axios.get(url, { timeout: TIMEOUT_SOURCE, headers }).catch(() => ({ data: "" }));
        if (!data) return [];

        const $ = cheerio.load(data);

        $("table.table-list tbody tr").each((_, row) => {
            const tds = $(row).find("td");
            let nameLink = tds.eq(0).find("a[href^='/torrent/']").first();
            if (!nameLink.length) nameLink = tds.eq(0).find("a").eq(1);
            if (!nameLink.length) return;

            const name = nameLink.text().trim();
            const torrentPath = nameLink.attr("href");
            if (!torrentPath || !ITA_REGEX.test(name)) return;

            const seeders = parseInt(tds.eq(1).text().replace(/,/g, "")) || 0;
            const sizeText = tds.eq(4).text();
            candidates.set(torrentPath, { name, path: torrentPath, seeders, size: sizeText });
        });

        // Solo i primi 8 per velocità
        const topCandidates = [...candidates.values()].sort((a, b) => b.seeders - a.seeders).slice(0, 8);

        const magnets = await Promise.all(topCandidates.map(async c => {
            try {
                const { data: detailData } = await axios.get(BASE_1337X + c.path, { timeout: 4000, headers });
                const $$ = cheerio.load(detailData);
                let magnet = $$("a[href^='magnet:']").first().attr("href");
                if (!magnet) {
                    const match = $$('body').html().match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+/);
                    if (match) magnet = match[0];
                }
                if (!magnet) return null;
                const infoHash = extractInfoHash(magnet);
                if (!infoHash) return null;

                return {
                    title: c.name, magnet: buildMagnet(infoHash, c.name), size: c.size, sizeBytes: parseSize(c.size),
                    seeders: c.seeders, source: "1337x", quality: extractQuality(c.name)
                };
            } catch (e) { return null; }
        }));
        return magnets.filter(Boolean);
    } catch (e) { return []; }
}

/* ===========================================================
   🌊 3. APIBAY
   =========================================================== */
async function searchAPIBay(title, year) {
    try {
        const cleanTitle = cleanString(title);
        const query = year ? `${cleanTitle} ${year}` : cleanTitle;
        const { data } = await axios.get(APIBAY_URL, {
            params: { q: query, cat: year ? 200 : 205 },
            timeout: TIMEOUT_SOURCE
        });

        if (!Array.isArray(data) || !data.length || data[0].name === "No results returned") return [];

        return data.filter(item => ITA_REGEX.test(item.name)).map(item => {
            if (!item.info_hash) return null;
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
        }).filter(Boolean).slice(0, 15); // Limite per performance
    } catch (e) { return []; }
}

/* ===========================================================
   🦉 4. KNABEN
   =========================================================== */
async function searchKnaben(title, year) {
    try {
        const cleanTitle = cleanString(title);
        const query = year ? `${cleanTitle} ${year}` : cleanTitle;
        const url = `${KNABEN_BASE_URL}/search/${encodeURIComponent(query)}/0/1/seeders`;
        
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_SOURCE, // Timeout di sicurezza
            headers: { 'User-Agent': USER_AGENT }
        });

        const $ = cheerio.load(data);
        const results = [];

        $('table tbody tr').each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 5) return;
            const torrentTitle = $(cells[1]).find('a').first().text().trim();
            if (!ITA_REGEX.test(torrentTitle)) return; // Filtro ITA

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
    } catch (e) { return []; }
}

/* ===========================================================
   📊 5. UINDEX
   =========================================================== */
async function searchUIndex(query) {
    try {
        const url = `${UINDEX_BASE_URL}/search.php?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_SOURCE, // Timeout di sicurezza
            headers: { 'User-Agent': USER_AGENT }
        });

        if (!data || typeof data !== 'string') return [];
        const rows = data.split(/<tr[^>]*>/gi).filter(r => r.includes('magnet:'));
        
        return rows.map(row => {
            try {
                const magnetMatch = row.match(/(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s<>]*)/i);
                if (!magnetMatch) return null;
                const magnetLink = decodeHtmlEntities(magnetMatch[1]);
                const cells = row.split(/<td[^>]*>/).map(c => c.replace(/<\/td>/g, '').trim());

                if (cells.length < 3) return null;
                
                let title = cells[2].replace(/<[^>]+>/g, '').trim();
                title = decodeHtmlEntities(title);

                if (!ITA_REGEX.test(title)) return null;

                const sizeStr = cells[3] ? cells[3].replace(/<[^>]+>/g, '').trim() : "Unknown";
                const seeders = cells[4] ? (parseInt(cells[4].replace(/<[^>]+>/g, '')) || 0) : 0;

                return {
                    title, magnet: magnetLink, size: sizeStr, sizeBytes: parseSize(sizeStr),
                    seeders: seeders, source: 'UIndex', quality: extractQuality(title)
                };
            } catch (err) { return null; }
        }).filter(Boolean);

    } catch (e) { return []; }
}

/* ===========================================================
   🔴 MAIN SEARCH AGGREGATOR
   =========================================================== */
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    
    // Logica Query
    const queryCorsaro = cleanTitle;
    const queryUIndex = `${cleanTitle} ITA`;
    const queryGlobal = year ? `${cleanTitle} ${year}` : cleanTitle;
    
    // Fix Serie TV Corsaro
    let corsaroQueryFinal = cleanTitle;
    const seriesMatch = cleanTitle.match(/(.+?)\s+S(\d{1,2})/i); 
    if (seriesMatch) {
        const cleanName = seriesMatch[1].trim();
        const seasonNum = parseInt(seriesMatch[2]);
        corsaroQueryFinal = `${cleanName} Stagione ${seasonNum}`;
    }

    console.log(`\n🔍 Search: "${cleanTitle}"`);

    // Usiamo Promise.allSettled per far girare TUTTO in parallelo senza bloccare se uno fallisce
    const promises = [
        searchCorsaro(corsaroQueryFinal),        
        search1337x(cleanTitle, year),  
        searchAPIBay(cleanTitle, year), 
        searchKnaben(cleanTitle, year), 
        searchUIndex(queryUIndex)       
    ];

    const resultsArray = await Promise.allSettled(promises);
    
    let allResults = [];
    resultsArray.forEach(res => {
        if (res.status === 'fulfilled') allResults.push(...res.value);
    });

    // --- Deduplicazione ---
    const uniqueMap = new Map();
    allResults.forEach(item => {
        // Doppio controllo ITA (tranne per Corsaro/UIndex che sono già ITA)
        const isItaSource = item.source === 'CorsaroNero' || item.source === 'UIndex';
        if (!isItaSource && !ITA_REGEX.test(item.title)) return;

        const hash = extractInfoHash(item.magnet);
        if (!hash) return;

        item.infoHash = hash; 
        item.magnetLink = item.magnet; 

        if (!uniqueMap.has(hash)) {
            uniqueMap.set(hash, item);
        } else {
            const existing = uniqueMap.get(hash);
            // Corsaro vince sempre per priorità
            if (item.source === 'CorsaroNero' || (item.source === 'UIndex' && existing.source !== 'CorsaroNero')) {
                uniqueMap.set(hash, item);
            } else if (item.seeders > existing.seeders && existing.source !== 'CorsaroNero') {
                uniqueMap.set(hash, item);
            }
        }
    });

    const uniqueResults = [...uniqueMap.values()];

    // --- Ordinamento ---
    uniqueResults.sort((a, b) => {
        const isCorsaroA = a.source === 'CorsaroNero';
        const isCorsaroB = b.source === 'CorsaroNero';
        if (isCorsaroA && !isCorsaroB) return -1;
        if (!isCorsaroA && isCorsaroB) return 1;
        
        const qScore = (q) => (q === '4k' ? 3 : q === '1080p' ? 2 : 1);
        if (qScore(b.quality) !== qScore(a.quality)) return qScore(b.quality) - qScore(a.quality);
        
        return b.seeders - a.seeders;
    });

    console.log(`✅ Risultati: ${uniqueResults.length}`);
    return uniqueResults.slice(0, 80); 
}

module.exports = { searchMagnet };
