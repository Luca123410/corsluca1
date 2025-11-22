const axios = require("axios");

// --- CONFIGURAZIONE NETWORK ---
const TIMEOUT_MS = 8000; // Non aspettiamo in eterno

// Lista User-Agent rotativi per non farsi bannare dalle API dirette
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// --- PROVIDER ESTERNI (ADDON) ---
const ADDON_PROVIDERS = [
    { name: "Torrentio", url: "https://torrentio.strem.fun", type: "torrentio" },
    { name: "KnightCrawler", url: "https://knightcrawler.elfhosted.com", type: "torrentio" },
    { name: "MediaFusion", url: "https://mediafusion.elfhosted.com", type: "mediafusion" }
];

// --- UTILITIES ---
function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/* ===========================================================
   A. GESTIONE ADDON WRAPPERS (Torrentio, KC, MF)
   =========================================================== */
async function fetchFromAddon(provider, id, type) {
    try {
        const url = `${provider.url}/stream/${type}/${id}.json`;
        const { data } = await axios.get(url, { timeout: 5000 }); // Timeout breve per gli addon

        if (!data || !data.streams) return [];

        return data.streams.map(stream => {
            let title = "Unknown";
            let size = "Unknown";
            let sizeBytes = 0;
            let seeders = 0;
            let source = provider.name;

            if (provider.type === "torrentio") {
                const lines = stream.title.split('\n');
                title = lines[0] || stream.title;
                const metaLine = lines.find(l => l.includes('💾'));
                if (metaLine) {
                    const sizeMatch = metaLine.match(/💾\s+(.*?)(?:\s|$)/);
                    if (sizeMatch) size = sizeMatch[1];
                    const seedMatch = metaLine.match(/👤\s+(\d+)/);
                    if (seedMatch) seeders = parseInt(seedMatch[1]);
                    // Rinomina la fonte per brevità
                    source = provider.name === "Torrentio" ? "Tio" : "KC";
                }
            } else if (provider.type === "mediafusion") {
                const desc = stream.description || stream.title; 
                const lines = desc.split('\n');
                title = lines[0].replace("📂 ", "").replace("/", "").trim();
                
                // Fix ITA nascosto
                const fullText = desc.toLowerCase();
                if ((fullText.includes("ita") || fullText.includes("italian")) && !title.toLowerCase().includes("ita")) {
                    title += " [ITA]";
                }
                source = "MediaFusion";
            }

            // Parsing SizeBytes generico
            if (size !== "Unknown") {
                const num = parseFloat(size);
                if (size.includes("GB")) sizeBytes = num * 1024 * 1024 * 1024;
                else if (size.includes("MB")) sizeBytes = num * 1024 * 1024;
            }

            return {
                title, size, sizeBytes, seeders,
                magnet: stream.url,
                source: source
            };
        });
    } catch (e) { return []; }
}

/* ===========================================================
   B. API DIRETTE "NASCOSTE" (BitSearch, Solid, YTS)
   =========================================================== */

const BitSearch = {
    search: async (query) => {
        try {
            const url = `https://bitsearch.to/api/v1/torrents/search?q=${encodeURIComponent(query)}&sort=size`;
            const { data } = await axios.get(url, { 
                timeout: TIMEOUT_MS, 
                headers: { 'User-Agent': getRandomUA() } // User Agent Random!
            });
            if (!data || !data.results) return [];
            return data.results.map(item => ({
                title: item.name,
                size: formatBytes(item.size),
                sizeBytes: item.size,
                magnet: item.magnet,
                seeders: parseInt(item.seeders || 0),
                source: "BitSearch"
            }));
        } catch (e) { return []; }
    }
};

const SolidTorrents = {
    search: async (query) => {
        try {
            const url = `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(query)}&sort=size`;
            const { data } = await axios.get(url, { 
                timeout: TIMEOUT_MS,
                headers: { 'User-Agent': getRandomUA() }
            });
            if (!data || !data.results) return [];
            return data.results.map(item => ({
                title: item.title,
                size: formatBytes(item.size),
                sizeBytes: item.size,
                magnet: item.magnet,
                seeders: parseInt(item.swarm?.seeders || 0),
                source: "SolidTorrents"
            }));
        } catch (e) { return []; }
    }
};

const YTS = {
    search: async (imdbId) => {
        if (!imdbId || !imdbId.startsWith('tt')) return [];
        try {
            const url = `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}`;
            const { data } = await axios.get(url, { 
                timeout: TIMEOUT_MS,
                headers: { 'User-Agent': getRandomUA() }
            });
            if (!data || !data.data || !data.data.movies) return [];
            let results = [];
            data.data.movies.forEach(movie => {
                if (movie.torrents) {
                    movie.torrents.forEach(t => {
                        const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://open.demonii.com:1337/announce`;
                        results.push({
                            title: `${movie.title} ${t.quality} ${t.type.toUpperCase()} YTS`,
                            size: t.size,
                            sizeBytes: t.size_bytes,
                            magnet: magnet,
                            seeders: t.seeds || 0,
                            source: "YTS"
                        });
                    });
                }
            });
            return results;
        } catch (e) { return []; }
    }
};

/* ===========================================================
   MAIN FUNCTION (Chiamata da addon.js)
   =========================================================== */
async function searchMagnet(query, type, imdbId) {
    console.log(`🌍 GLOBAL SEARCH (External): "${query}"`);
    
    let promises = [];

    // 1. Aggiungi Addon Wrappers (Torrentio, ecc.)
    ADDON_PROVIDERS.forEach(p => promises.push(fetchFromAddon(p, imdbId || query, type)));

    // 2. Aggiungi API Dirette (Quelle che abbiamo nascosto)
    promises.push(BitSearch.search(query));
    promises.push(SolidTorrents.search(query));
    
    if (type === 'movie' && imdbId) {
        promises.push(YTS.search(imdbId));
    }

    // Esegui tutto in parallelo con Promise.allSettled per non bloccare se uno fallisce
    const resultsArray = await Promise.allSettled(promises);
    
    let allResults = [];
    resultsArray.forEach(res => {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            allResults = allResults.concat(res.value);
        }
    });

    return allResults;
}

module.exports = { searchMagnet };
