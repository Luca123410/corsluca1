
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
const TorrentMagnet = require("./torrentmagnet"); // Il tuo motore Core
const External = require("./external"); // Il "Black Box"

// --- CONFIGURAZIONE NETWORK ---
const axiosInstance = axios.create({
    timeout: 15000, 
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: { 'User-Agent': 'Corsaro-Alias-Hunter/23.5.0' }
});

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); 
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 }); 

const app = express();
app.use(cors());
// --- SICUREZZA SERVER ---
app.disable('x-powered-by'); 
// ------------------------
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-stealth",
    version: "23.5.4", // Bump versione
    name: "Corsaro + Global (Stealth Edition)",
    description: "🇮🇹 V23.5.4: Fix Serie TV (Ricerca Semplificata/Robusta) + Priorità Esterna.",
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
    const t = (title || "").toLowerCase();
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
    
    return { quality, extraInfo: extra.join(" | ") };
}

// --- METADATA ---
async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        let seasonNum, episodeNum;
        
        // Gestione ID composti (es. tt12345:1:1 o tmdb:123:1:1)
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0]; 
            seasonNum = parseInt(parts[1]); 
            episodeNum = parseInt(parts[2]);
        }
        
        // Risoluzione IMDb ID -> TMDB ID
        if (tmdbId.startsWith('tt')) {
            const res = await axiosInstance.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
            if (type === 'movie' && res.data.movie_results?.[0]) tmdbId = res.data.movie_results[0].id;
            else if (type === 'series' && res.data.tv_results?.[0]) tmdbId = res.data.tv_results[0].id;
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
                isSeries: type === 'series', 
                season: seasonNum, 
                episode: episodeNum,
                imdb_id: details.external_ids?.imdb_id
            };
        }
        return null;
    } catch (e) { 
        console.error("Error fetching metadata:", e.message);
        return null; 
    }
}

// --- STREAM HANDLER ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, torbox, tmdb } = config || {}; 
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: (Richiesta Cache Anonima)`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE: Nuova richiesta stream elaborata`);
    
    if ((!rd && !torbox) || !tmdb) return { streams: [{ title: "⚠️ Configurazione Mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        let queries = [];

        // --- QUERY GENERATION (Robusta) ---
        if (metadata.isSeries) {
            const s = metadata.season.toString().padStart(2, '0');
            const e = metadata.episode.toString().padStart(2, '0');
            
            // 1. Titolo Principale + Episodio (Più preciso)
            queries.push(`${metadata.title} S${s}E${e}`); 
            // 2. Primo Alias + Episodio (Per titoli come 'Stranger Things 2')
            if (metadata.aliases[1]) queries.push(`${metadata.aliases[1]} S${s}E${e}`);
            // 3. Titolo Principale + Pack Stagione (Fallback)
            queries.push(`${metadata.title} S${s}`);      
        } else {
            // Se è un film, Titolo + Anno
            queries.push(`${metadata.title} ${metadata.year}`); 
        }

        const safeSearch = (promise) => {
            return new Promise(resolve => {
                const timeout = setTimeout(() => resolve([]), 9000); 
                promise.then(res => { clearTimeout(timeout); resolve(res); })
                        .catch(() => { clearTimeout(timeout); resolve([]); });
            });
        };

        // --- FIX: Passiamo null per anno alle serie per non filtrare file validi ---
        const yearFilter = metadata.isSeries ? null : metadata.year;
        
        // 1. 🔥 ESEGUI RICERCA CORE (TorrentMagnet) con le 3 query migliori
        let corePromises = [];
        queries.slice(0, 3).forEach(q => {
             corePromises.push(safeSearch(TorrentMagnet.searchMagnet(q, yearFilter))); 
        });
        
        const coreResultsArray = await Promise.all(corePromises);
        let allResults = coreResultsArray.flat();

        // 2. 🌍 ESEGUI RICERCA ESTERNA (SOLO SE RISULTATI CORE < 2)
        const initialCount = allResults.length;

        if (initialCount < 2) { // PRIORITY FILTER
            let externalPromises = [];
            if (!filters.onlyIta) {
                 // Usa la query primaria (queries[0]) per la ricerca esterna
                 externalPromises.push(safeSearch(External.searchMagnet(id, type, metadata.imdb_id, queries[0]))); 
            }
            const externalResultsArray = await Promise.all(externalPromises);
            allResults.push(...externalResultsArray.flat());
        }

        // --- DEDUPLICAZIONE ---
        let uniqueMap = new Map();
        const prioritySources = ["Corsaro", "CorsaroNero", "UIndex", "Knaben", "1337x", "Apibay"]; 

        for (const item of allResults) {
            if (!item || !item.magnet) continue;
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            
            const itemSource = item.source || "Unknown";
            const isPriority = prioritySources.some(s => itemSource.includes(s));

            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, item);
            } else {
                const existing = uniqueMap.get(key);
                const existingSource = existing.source || "Unknown";
                const existingIsPriority = prioritySources.some(s => existingSource.includes(s));
                
                if (isPriority && !existingIsPriority) uniqueMap.set(key, item);
                else if (isPriority && existingIsPriority && ((item.seeders || 0) > (existing.seeders || 0))) uniqueMap.set(key, item);
            }
        }
        let uniqueResults = Array.from(uniqueMap.values());

        // --- FILTRAGGIO ---
        uniqueResults = uniqueResults.filter(item => {
            const itemSource = item.source || "Unknown";
            const itemTitle = item.title || "Unknown";

            if (metadata.isSeries) {
                // FIX: Includi le sorgenti Core nella lista "Trusted" per evitare di filtrare i risultati di CorsaroNero
                const externalTrusted = ["Tio", "Torrentio", "BitSearch", "SolidTorrents", "YTS"].some(s => itemSource.includes(s));
                const isTrusted = prioritySources.some(s => itemSource.includes(s)) || externalTrusted;

                if (!isTrusted && !isExactEpisodeMatch(itemTitle, metadata.season, metadata.episode)) return false;
            }
            
            // --- FILTRO LINGUA (Stesso di prima, basato su onlyIta) ---
            if (filters.onlyIta) {
                 const t = itemTitle.toLowerCase();
                 if (itemSource.includes("Corsaro")) return true;
                 const advancedItaRegex = /\b(ita|italian|italiano|multi|dual|md|sub[\s._-]?ita|forced|ac3[\s._-]?ita|dts[\s._-]?ita|cinefile|novarip|mem|robbyrs|idn_crew|pso|badass)\b/i;
                 return advancedItaRegex.test(t);
            }
            return true;
        });

        // --- ORDINAMENTO ---
        uniqueResults.sort((a, b) => {
            const getRank = (item) => {
                const t = (item.title || "").toLowerCase();
                const s = (item.source || "").toLowerCase(); // Fix crash on source null
                const isIta = /\b(ita|italian)\b/i.test(t) || s.includes("corsaro");
                const is4k = /2160p|4k|uhd/i.test(t);
                if (isIta && (is4k || /1080p|fhd/i.test(t))) return 4;
                if (is4k) return 3;
                if (isIta) return 2;
                return 1;
            };
            const rA = getRank(a);
            const rB = getRank(b);
            if (rA !== rB) return rB - rA;
            return (b.seeders || 0) - (a.seeders || 0) || (b.sizeBytes || 0) - (a.sizeBytes || 0); 
        });

        const topResults = uniqueResults.slice(0, 150); 

        // --- GENERAZIONE STREAMS ---
        let streams = [];
        for (const item of topResults) {
            let streamData = null;
            const itemMagnet = item.magnet;
             
            if (torbox) {
                try {
                    streamData = await DebridX.getStreamLink(config.torbox, itemMagnet);
                } catch (e) { /* Ignora errori Torbox */ }
            }

            if (!streamData && rd) {
                try {
                    streamData = await RD.getStreamLink(config.rd, itemMagnet);
                } catch (e) { /* Ignora errori RD */ }
            }
            
            const itemTitle = item.title || "Unknown";
            const fileTitle = streamData?.filename || itemTitle;
            const { quality, extraInfo } = extractStreamInfo(fileTitle);
            
            // Fix: Usa sizeBytes se size stringa è assente
            const finalSize = streamData?.size 
                ? formatBytes(streamData.size) 
                : (item.size || (item.sizeBytes ? formatBytes(item.sizeBytes) : "??"));

            const seeders = item.seeders || 0;
            const itemSource = item.source || "Unknown";
            
            // --- UI LOGIC ---
            let langLabel = "GB 🇬🇧"; 
            let flagIcon = "🇬🇧";
            
            const lowerTitle = fileTitle.toLowerCase();
            const lowerSource = itemSource.toLowerCase();

            if (/\b(multi|dual|md)\b/i.test(lowerTitle)) {
                langLabel = "GB + IT";
                flagIcon = "🌐"; 
            } else if (lowerSource.includes("corsaro") || /\b(ita|italian)\b/i.test(lowerTitle)) {
                langLabel = "IT";
                flagIcon = "🇮🇹";
            } else if (/\b(sub[\s._-]?ita)\b/i.test(lowerTitle)) {
                langLabel = "SUB IT";
                flagIcon = "🇮🇹";
            }

            // Stile UI
            const nameLine = `${flagIcon} ${langLabel}\n${itemSource} ${quality}`;
            
            let titleStr = `📂 ${fileTitle}\n`;
            titleStr += `💾 ${finalSize}   👤 ${seeders}\n`;
            titleStr += `🌐 ${flagIcon} ${langLabel}`;
            if (extraInfo) titleStr += ` | ${extraInfo}`;
            titleStr += `\n🔗 ${itemSource}`;

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
                    url: itemMagnet,
                    behaviorHints: { notWebReady: true, bingeGroup: "uncached" }
                });
            }
        }

        const finalResponse = streams.length === 0 
            ? { streams: [{ title: "🚫 Nessun file trovato (Verifica filtri)" }] } 
            : { streams };

        console.log(`💾 Risultati finali inviati: ${streams.length}`);
        streamCache.set(cacheKey, finalResponse, streams.length > 0 ? 900 : 120);

        return finalResponse;
    } catch (error) {
        console.error("🔥 Errore Stream:", error.message);
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ metas: [] });
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
app.listen(PORT, () => console.log(`Addon v23.5.4 (Series Robust) attivo su porta ${PORT}!`));
