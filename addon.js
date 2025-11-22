const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");
const http = require('http');
const https = require('https');

// --- MODULI ESTERNI ---
const RD = require("./rd");
const DebridX = require("./debridx"); // Torbox
// NOTA: Corsaro, UIndex, Apibay sono stati eliminati perché ora sono dentro TorrentMagnet
const TorrentMagnet = require("./torrentmagnet"); 
const External = require("./external"); 

// --- CONFIGURAZIONE NETWORK ---
const axiosInstance = axios.create({
    timeout: 15000, 
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: { 'User-Agent': 'Corsaro-Alias-Hunter/23.4.16' }
});

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); 
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 }); 

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-alias-hunter",
    version: "23.4.16", 
    name: "Corsaro + Global (Visual Fix)",
    description: "🇮🇹 V23.4.16: Motore Unificato + Fix Etichette ITA/MULTI visibili.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// --- UTILITIES ---
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getConfig(configStr) {
    try { 
        const config = JSON.parse(Buffer.from(configStr, 'base64').toString()); 
        return {
            rd: config.rd,
            torbox: config.torbox,
            tmdb: config.tmdb,
            filters: config.filters || {}
        };
    } catch (e) { return {}; }
}

// --- PROVIDER GLOBALI (Backup) ---
const BitSearch = {
    searchMagnet: async (query) => {
        try {
            const url = `https://bitsearch.to/api/v1/torrents/search?q=${encodeURIComponent(query)}&sort=size`;
            const { data } = await axiosInstance.get(url);
            if (!data || !data.results) return [];
            return data.results.map(item => ({
                title: item.name,
                size: formatBytes(item.size),
                sizeBytes: item.size,
                magnet: item.magnet,
                source: "BitSearch"
            }));
        } catch (e) { return []; }
    }
};

const SolidTorrents = {
    searchMagnet: async (query) => {
        try {
            const url = `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(query)}&sort=size`;
            const { data } = await axiosInstance.get(url);
            if (!data || !data.results) return [];
            return data.results.map(item => ({
                title: item.title,
                size: formatBytes(item.size),
                sizeBytes: item.size,
                magnet: item.magnet,
                source: "SolidTorrents"
            }));
        } catch (e) { return []; }
    }
};

const YTS = {
    searchMagnet: async (imdbId) => {
        if (!imdbId || !imdbId.startsWith('tt')) return [];
        try {
            const url = `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}`;
            const { data } = await axiosInstance.get(url);
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
                            source: "YTS"
                        });
                    });
                }
            });
            return results;
        } catch (e) { return []; }
    }
};

// --- SMART MATCHING ---
function isExactEpisodeMatch(torrentTitle, season, episode) {
    if (!torrentTitle) return false;
    const title = torrentTitle.toLowerCase();
    const s = season;
    const e = episode;
    const sStr = String(s).padStart(2, '0');
    const eStr = String(e).padStart(2, '0');

    const exactPatterns = [
        new RegExp(`s${sStr}[^0-9]*e${eStr}`, 'i'),
        new RegExp(`\\b${s}x${eStr}\\b`, 'i'),
        new RegExp(`s${sStr}\\.?e${eStr}`, 'i'),
        new RegExp(`${sStr}x${eStr}`, 'i')
    ];
    if (exactPatterns.some(p => p.test(title))) return true;

    if (title.includes('-') || title.includes('–') || title.includes('to')) {
        const rangePattern = new RegExp(`s${sStr}e(\\d{1,2})\\s*[-–—to]\\s*e?(\\d{1,2})`, 'i');
        const rangeMatch = title.match(rangePattern);
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1]);
            const end = parseInt(rangeMatch[2]);
            if (e >= start && e <= end) return true;
        }
    }

    const packPatterns = [
        new RegExp(`stagione\\s*${s}(?!\\d)`, 'i'),
        new RegExp(`season\\s*${s}(?!\\d)`, 'i'),
        new RegExp(`s${sStr}\\s*(?:completa|complete|pack|full|tutta)`, 'i'),
        new RegExp(`s${sStr}\\s*$`, 'i')
    ];
    
    if (packPatterns.some(p => p.test(title))) {
        if (title.match(/e\d{2}/i) && !exactPatterns[0].test(title)) return false; 
        return true;
    }
    return false;
}

// --- PARSING STREAM INFO ---
function extractStreamInfo(title) {
    const t = title.toLowerCase();
    let quality = "Unknown";
    
    if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) quality = "4k";
    else if (t.includes("1080p") || t.includes("fhd")) quality = "1080p";
    else if (t.includes("720p") || t.includes("hd")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    else if (t.includes("dvdrip") || t.includes("dvd")) quality = "DVD";

    let extra = [];
    if (t.includes("hdr")) extra.push("HDR");
    if (t.includes("dolby vision") || t.includes("dv")) extra.push("DV");
    if (t.includes("hevc") || t.includes("x265") || t.includes("h265")) extra.push("HEVC");
    
    // Le info sulla lingua le gestiamo direttamente nel loop finale per l'etichetta
     
    return { quality, extraInfo: extra.join(" | ") };
}

// --- METADATA ---
async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        let seasonNum, episodeNum;
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0]; seasonNum = parseInt(parts[1]); episodeNum = parseInt(parts[2]);
        }
        
        if (tmdbId.startsWith('tt')) {
            const res = await axiosInstance.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
            if (type === 'movie' && res.data.movie_results[0]) tmdbId = res.data.movie_results[0].id;
            else if (type === 'series' && res.data.tv_results[0]) tmdbId = res.data.tv_results[0].id;
        } else if (tmdbId.startsWith('tmdb:')) {
            tmdbId = tmdbId.split(':')[1];
        }

        const append = "alternative_titles,external_ids";
        const res = await axiosInstance.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${tmdbKey}&language=it-IT&append_to_response=${append}`);
        const details = res.data;

        if (details) {
            const rawAliases = details.alternative_titles ? (details.alternative_titles.titles || details.alternative_titles.results || []) : [];
            const usefulAliases = rawAliases
                .filter(a => ['US', 'GB', 'ES', 'FR'].includes(a.iso_3166_1))
                .map(a => a.title);

            let aliases = [details.title || details.name, details.original_title || details.original_name, ...usefulAliases];
            aliases = [...new Set(aliases.filter(Boolean))];

            return {
                title: details.title || details.name,
                aliases: aliases,
                year: (details.release_date || details.first_air_date)?.split('-')[0],
                isSeries: type === 'series', season: seasonNum, episode: episodeNum,
                imdb_id: details.external_ids?.imdb_id
            };
        }
        return null;
    } catch (e) { return null; }
}

// --- STREAM HANDLER ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, torbox, tmdb } = config || {}; 
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE (V23.4.16): ${id}`);
    if (!rd && !torbox || !tmdb) return { streams: [{ title: "⚠️ Configurazione Mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        let queries = [];
        queries.push(`${metadata.title} ${metadata.year}`); 
        if (metadata.aliases[1]) queries.push(`${metadata.aliases[1]} ${metadata.year}`);

        const safeSearch = (promise) => {
            return new Promise(resolve => {
                const timeout = setTimeout(() => resolve([]), 8000); 
                promise.then(res => { clearTimeout(timeout); resolve(res); })
                        .catch(() => { clearTimeout(timeout); resolve([]); });
            });
        };

        let promises = [];
        promises.push(safeSearch(TorrentMagnet.searchMagnet(queries[0], metadata.year)));

        if (!filters.onlyIta) {
            promises.push(safeSearch(BitSearch.searchMagnet(queries[0])));
            promises.push(safeSearch(SolidTorrents.searchMagnet(queries[0])));
            if (!metadata.isSeries && metadata.imdb_id) {
                promises.push(safeSearch(YTS.searchMagnet(metadata.imdb_id)));
            }
        }

        const resultsArray = await Promise.all(promises);
        let allResults = resultsArray.flat();

        if (allResults.length === 0 && !filters.onlyIta) {
            console.log(`🚨 EMERGENZA: External attivato per ${id}...`);
            try {
                const extResults = await safeSearch(External.searchMagnet(id, type));
                if (extResults.length > 0) allResults = allResults.concat(extResults);
            } catch (e) {}
        }

        // --- DEDUPLICAZIONE ---
        let uniqueMap = new Map();
        const prioritySources = ["Corsaro", "CorsaroNero", "UIndex", "Knaben", "1337x", "Apibay"]; 

        for (const item of allResults) {
            if (!item || !item.magnet) continue;
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            
            const isPriority = prioritySources.some(s => item.source.includes(s));

            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, item);
            } else {
                const existing = uniqueMap.get(key);
                const existingIsPriority = prioritySources.some(s => existing.source.includes(s));
                if (isPriority && !existingIsPriority) uniqueMap.set(key, item);
                else if (isPriority && existingIsPriority && (item.seeders > existing.seeders)) uniqueMap.set(key, item);
            }
        }
        let uniqueResults = Array.from(uniqueMap.values());

        // --- FILTRAGGIO ---
        uniqueResults = uniqueResults.filter(item => {
            if (metadata.isSeries) {
                const isTrusted = ["Tio", "Torrentio", "BitSearch", "SolidTorrents", "YTS"].some(s => item.source.includes(s));
                if (!isTrusted && !isExactEpisodeMatch(item.title, metadata.season, metadata.episode)) return false;
            }
            if (filters.onlyIta) {
                 const t = item.title.toLowerCase();
                 if (item.source.includes("Corsaro")) return true;
                 const advancedItaRegex = /\b(ita|italian|italiano|multi|dual|md|sub[\s._-]?ita|forced|ac3[\s._-]?ita|dts[\s._-]?ita|cinefile|novarip|mem|robbyrs|idn_crew|pso|badass)\b/i;
                 return advancedItaRegex.test(t);
            }
            return true;
        });

        // --- ORDINAMENTO ---
        uniqueResults.sort((a, b) => {
            const getRank = (item) => {
                const isIta = /\b(ita|italian)\b/i.test(item.title) || item.source.includes("Corsaro");
                const is4k = /2160p|4k|uhd/i.test(item.title);
                if (isIta && (is4k || /1080p|fhd/i.test(item.title))) return 4;
                if (is4k) return 3;
                if (isIta) return 2;
                return 1;
            };
            const rA = getRank(a);
            const rB = getRank(b);
            if (rA !== rB) return rB - rA;
            return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        });

        const topResults = uniqueResults.slice(0, 150); 

        // --- GENERAZIONE STREAMS (FIX NOMI) ---
        let streams = [];
        for (const item of topResults) {
            let streamData = null;
            let debridService = null;
             
            if (torbox) {
                try {
                    streamData = await DebridX.getStreamLink(config.torbox, item.magnet);
                    if (streamData) debridService = 'Torbox';
                } catch (e) { }
            }

            if (!streamData && rd) {
                try {
                    streamData = await RD.getStreamLink(config.rd, item.magnet);
                    if (streamData) debridService = 'RD';
                } catch (e) { }
            }
            
            const fileTitle = streamData?.filename || item.title;
            const { quality, extraInfo } = extractStreamInfo(fileTitle);
            const finalSize = streamData?.size ? formatBytes(streamData.size) : (item.size || "??");
            
            // --- LOGICA ETICHETTE VISIVE ---
            let langLabel = "ENG/INTL 🌐"; // Default
            const lowerTitle = fileTitle.toLowerCase();
            const lowerSource = item.source.toLowerCase();

            if (lowerSource.includes("corsaro")) {
                langLabel = "ITA 🇮🇹";
            } else if (/\b(multi|dual|md)\b/i.test(lowerTitle)) {
                langLabel = "MULTI 🌐";
            } else if (/\b(sub[\s._-]?ita)\b/i.test(lowerTitle)) {
                langLabel = "SUB ITA 🇮🇹";
            } else if (/\b(ita|italian)\b/i.test(lowerTitle)) {
                langLabel = "ITA 🇮🇹";
            }

            // --- FORMATTAZIONE NOME STREMIO ---
            // Formato: [ITA 🇮🇹] CorsaroNero
            // Riga sotto: 4k [29 GB]
            const nameLine = `[${langLabel}] ${item.source}\n${quality} [${finalSize}]`;

            let titleStr = `📄 ${fileTitle}\n💾 ${finalSize}`;
            if (extraInfo) titleStr += ` | ${extraInfo}`;
            titleStr += `\n⚙️ ${item.source}`;

            if (streamData) {
                streams.push({
                    name: nameLine,
                    title: titleStr,
                    url: streamData.url
                });
            } else if (filters.showFake) {
                streams.push({
                    name: nameLine,
                    description: "❄️ Uncached. Clicca per scaricare.",
                    title: `${titleStr}\n❄️ Download (No Cache)`,
                    url: item.magnet,
                    behaviorHints: { notWebReady: true, bingeGroup: "uncached" }
                });
            }
            await wait(2); 
        }

        const finalResponse = streams.length === 0 
            ? { streams: [{ title: "🚫 Nessun file trovato (Verifica filtri)" }] } 
            : { streams };

        console.log(`💾 Risultati finali inviati: ${streams.length}`);
        streamCache.set(cacheKey, finalResponse, streams.length > 0 ? 900 : 120);

        return finalResponse;
    } catch (error) {
        console.error("🔥 Errore:", error.message);
        return { streams: [{ title: "Errore Interno" }] };
    }
}

// --- ROUTING ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifestBase };
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    m.logo = `${protocol}://${host}/logo.png`;
    if ((config.tmdb && config.rd) || (config.tmdb && config.torbox)) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});

app.get('/:userConf/catalog/:type/:id.json', async (req, res) => {
    const result = await generateCatalog(req.params.type, req.params.id, getConfig(req.params.userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=43200');
    res.json(result);
});

app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const streams = await generateStream(
        req.params.type, 
        req.params.id.replace('.json', ''), 
        getConfig(req.params.userConf),
        req.params.userConf 
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=120'); 
    res.json(streams);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon v23.4.16 (Visual Fix) attivo su porta ${PORT}!`));
