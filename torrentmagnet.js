const axios = require("axios");
const cheerio = require("cheerio");

// --- CONFIGURAZIONE VERCEL ---
// Abbassiamo drasticamente i timeout.
// Se un sito non risponde in 2.5 secondi, Vercel deve passare oltre.
const TIMEOUT_SOURCE = 2500; 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36";

// --- URL ---
const CORSARO_BASE_URL = "https://ilcorsaronero.link";
const APIBAY_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to"; 
const KNABEN_BASE_URL = "https://knaben.org";

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "https://opentracker.i2p.rocks:443/announce"
];

// Regex più permissiva per catturare più risultati
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA)\b/i;

// --- UTILITIES ---
function cleanString(str) {
    return str.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toUpperCase() : null;
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|GiB|MB|MiB|KB|KiB)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit.includes('G')) val *= 1024 * 1024 * 1024;
    else if (unit.includes('M')) val *= 1024 * 1024;
    return Math.round(val);
}

// --- 1. APIBAY (VELOCISSIMO & SICURO SU VERCEL) ---
// Questa è l'arma segreta. Le API non bloccano Vercel quasi mai.
async function searchAPIBay(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        // APIBay è veloce, ma filtriamo noi per ITA
        const { data } = await axios.get(APIBAY_URL, {
            params: { q: query, cat: 200 }, // 200 = Video
            timeout: TIMEOUT_SOURCE
        });

        if (!Array.isArray(data) || data[0]?.name === "No results returned") return [];

        return data
            .filter(item => ITA_REGEX.test(item.name)) // Filtra ITA qui
            .map(item => ({
                title: item.name,
                magnet: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}`,
                size: (item.size / 1024 / 1024 / 1024).toFixed(2) + " GB",
                sizeBytes: parseInt(item.size),
                seeders: parseInt(item.seeders),
                source: 'APIBay'
            }));
    } catch (e) { return []; }
}

// --- 2. IL CORSARO NERO (CON FALLBACK RAPIDO) ---
async function searchCorsaro(query) {
    try {
        // Proviamo a scaricare. Se Vercel viene bloccato, questo va in timeout in 2.5s
        const { data } = await axios.get(`${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`, {
            timeout: TIMEOUT_SOURCE,
            headers: { 'User-Agent': USER_AGENT }
        });

        const $ = cheerio.load(data);
        let results = [];
        
        // Prendiamo solo i primi 5 per velocità
        $('tbody tr').slice(0, 5).each((_, row) => {
            const titleEl = $(row).find('a.tab');
            const title = titleEl.text().trim();
            const url = titleEl.attr('href');
            if (!url) return;
            
            // Qui c'è il problema: dobbiamo entrare nella pagina per il magnet.
            // Su Vercel questo raddoppia il rischio di blocco.
            // Salviamo il link parziale e speriamo che DebridX lo risolva o rischiamo la chiamata:
            
            results.push({
                title, url, 
                size: $(row).find('td').eq(3).text().trim(),
                seeders: parseInt($(row).find('td').eq(5).text()) || 0
            });
        });

        // Risoluzione parallela dei magnet (rischioso su Vercel, ma ci proviamo)
        const magnets = await Promise.all(results.map(async item => {
            try {
                const res = await axios.get(`${CORSARO_BASE_URL}${item.url}`, { timeout: 2000 });
                const $$ = cheerio.load(res.data);
                const magnet = $$('a[href^="magnet:"]').attr('href');
                if (magnet) return { ...item, magnet, source: 'CorsaroNero', sizeBytes: parseSize(item.size) };
            } catch (e) { return null; }
        }));

        return magnets.filter(Boolean);
    } catch (e) { 
        // Se Corsaro fallisce (molto probabile su Vercel), torniamo array vuoto SILENZIOSAMENTE
        return []; 
    }
}

// --- 3. 1337x (VERSIONE LIGHT) ---
async function search1337x(title) {
    try {
        const { data } = await axios.get(`${BASE_1337X}/sort-search/${encodeURIComponent(title)}/seeders/desc/1/`, {
            timeout: TIMEOUT_SOURCE, headers: { 'User-Agent': USER_AGENT }
        });
        const $ = cheerio.load(data);
        let candidates = [];

        $('table.table-list tr').slice(0, 4).each((_, row) => {
            const name = $(row).find('.name a').eq(1).text();
            const link = $(row).find('.name a').eq(1).attr('href');
            const seeds = parseInt($(row).find('.seeds').text()) || 0;
            if (name && link && ITA_REGEX.test(name)) candidates.push({ name, link, seeds });
        });

        const magnets = await Promise.all(candidates.map(async c => {
            try {
                const res = await axios.get(`${BASE_1337X}${c.link}`, { timeout: 2000 });
                const $$ = cheerio.load(res.data);
                const magnet = $$('a[href^="magnet:"]').attr('href');
                if (magnet) return { title: c.name, magnet, seeders: c.seeds, source: '1337x', sizeBytes: 0 };
            } catch (e) { return null; }
        }));
        return magnets.filter(Boolean);
    } catch (e) { return []; }
}

// --- MAIN SEARCH (PARALLELA E PROTETTA) ---
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    console.log(`🔍 Seeking: ${cleanTitle}`);

    // Strategia ilCorsaroViola:
    // Lanciamo tutto in parallelo, ma se uno fallisce, gli altri continuano.
    // Usiamo Promise.allSettled invece di Promise.all
    
    const queries = [
        searchAPIBay(cleanTitle, year), // Questo è il più affidabile su Vercel
        searchCorsaro(cleanTitle),      // Questo potrebbe fallire
        search1337x(cleanTitle)         // Questo potrebbe fallire
    ];

    const results = await Promise.allSettled(queries);
    
    let all = [];
    results.forEach(res => {
        if (res.status === 'fulfilled') all.push(...res.value);
    });

    // Deduplica base
    const seen = new Set();
    const unique = all.filter(item => {
        const hash = extractInfoHash(item.magnet);
        if (!hash || seen.has(hash)) return false;
        seen.add(hash);
        return true;
    });

    // Se non troviamo nulla, proviamo una ricerca "fallback" solo su APIBay senza anno (più ampia)
    if (unique.length === 0 && year) {
        const fallback = await searchAPIBay(cleanTitle, null);
        return fallback.slice(0, 10);
    }

    return unique.sort((a, b) => b.seeders - a.seeders).slice(0, 20);
}

module.exports = { searchMagnet };
