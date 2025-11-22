const axios = require("axios");
const { https } = require("follow-redirects");

// --- CONFIGURAZIONE ---
const TIMEOUT_MS = 8000; // 8 secondi massimo per provider
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
};

// --- UTILITIES ---
function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/* ===========================================================
   PART 1: STEALTH SCRAPERS (YTS, BitSearch, Solid)
   Questi cercano usando il TITOLO (Query)
   =========================================================== */

const BitSearch = {
    search: async (query) => {
        try {
            const url = `https://bitsearch.to/api/v1/torrents/search?q=${encodeURIComponent(query)}&sort=size`;
            const { data } = await axios.get(url, { headers, timeout: TIMEOUT_MS });
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
            const { data } = await axios.get(url, { headers, timeout: TIMEOUT_MS });
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
            const { data } = await axios.get(url, { headers, timeout: TIMEOUT_MS });
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
   PART 2: ADDON PROXIES (Torrentio, KC, MediaFusion)
   Questi cercano usando l'ID (tt12345)
   =========================================================== */

const ADDON_PROVIDERS = [
    { name: "Torrentio", url: "https://torrentio.strem.fun", parseType: "torrentio" },
    { name: "KnightCrawler", url: "https://knightcrawler.elfhosted.com", parseType: "torrentio" },
    { name: "MediaFusion", url: "https://mediafusion.elfhosted.com", parseType: "mediafusion" }
];

async function fetchFromAddon(provider, id, type) {
    try {
        const url = `${provider.url}/stream/${type}/${id}.json`;
        const { data } = await axios.get(url, { timeout: TIMEOUT_MS }); 

        if (!data || !data.streams) return [];

        return data.streams.map(stream => {
            let title = "Unknown";
            let size = "Unknown";
            let sizeBytes = 0;
            let seeders = 0;
            let source = provider.name;

            // --- PARSING LOGIC ---
            if (provider.parseType === "torrentio") {
                const lines = stream.title.split('\n');
                title = lines[0] || stream.title;
                
                const metaLine = lines.find(l => l.includes('💾'));
                if (metaLine) {
                    const sizeMatch = metaLine.match(/💾\s+(.*?)(?:\s|$)/);
                    if (sizeMatch) size = sizeMatch[1];
                    const seedMatch = metaLine.match(/👤\s+(\d+)/);
                    if (seedMatch) seeders = parseInt(seedMatch[1]);
                    
                    const providerPrefix = provider.name === "Torrentio" ? "Tio" : "KC";
                    const sourceMatch = metaLine.match(/⚙️\s+(.*)/);
                    if (sourceMatch) source = `${providerPrefix}|${sourceMatch[1]}`;
                }
            } 
            else if (provider.parseType === "mediafusion") {
                const desc = stream.description || stream.title; 
                const lines = desc.split('\n');
                title = lines[0].replace("📂 ", "").replace("/", "").trim();
                
                // Fix ITA Detection per MediaFusion
                const fullText = desc.toLowerCase();
                const hasHiddenIta = fullText.includes("🇮🇹") || fullText.includes("italian") || (fullText.includes("audio") && fullText.includes("ita"));

                if (hasHiddenIta && !title.toLowerCase().includes("ita")) title += " [ITA]";

                const seedLine = lines.find(l => l.includes("👤"));
                if (seedLine) seeders = parseInt(seedLine.split("👤 ")[1]) || 0;

                const sourceLine = lines.find(l => l.includes("🔗"));
                source = sourceLine ? `MF|${sourceLine.split("🔗 ")[1]}` : "MediaFusion";

                if (stream.behaviorHints && stream.behaviorHints.videoSize) {
                    sizeBytes = stream.behaviorHints.videoSize;
                    size = formatBytes(sizeBytes);
                }
            }

            // Normalizza dimensione
            if (sizeBytes === 0 && size !== "Unknown") {
                const num = parseFloat(size);
                if (size.includes("GB")) sizeBytes = num * 1024 * 1024 * 1024;
                else if (size.includes("MB")) sizeBytes = num * 1024 * 1024;
            }

            return {
                title: title,
                size: size,
                sizeBytes: sizeBytes,
                seeders: seeders,
                magnet: stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : stream.url,
                source: source
            };
        });

    } catch (e) { return []; }
}

/* ===========================================================
   MAIN FUNCTION (Unifica i due mondi)
   =========================================================== */

async function searchMagnet(id, type, imdbId, query) {
    // Questa funzione lancia TUTTO quello che abbiamo a disposizione
    
    let promises = [];

    // 1. Lancia i Proxy Addon (Usano l'ID)
    // Utile se il file esiste nei cataloghi di Torrentio/KC ma non lo troviamo noi
    ADDON_PROVIDERS.forEach(p => {
        promises.push(fetchFromAddon(p, id, type));
    });

    // 2. Lancia gli Scraper Diretti (Usano la Query/Titolo)
    // Utile per contenuti nuovi o rari non ancora indicizzati dagli addon
    if (query) {
        promises.push(BitSearch.search(query));
        promises.push(SolidTorrents.search(query));
    }
    if (type === 'movie' && imdbId) {
        promises.push(YTS.search(imdbId));
    }

    // Attendi tutti
    const results = await Promise.allSettled(promises);
    
    let allMagnets = [];
    results.forEach(res => {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            allMagnets.push(...res.value);
        }
    });

    return allMagnets;
}

module.exports = { searchMagnet };
