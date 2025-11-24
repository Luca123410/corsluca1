const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");
const http = require('http');
const https = require('https');

// --- MODULI ESTERNI ---
// Assicurati di caricare anche questi file su GitHub/Vercel!
const RD = require("./rd");
const DebridX = require("./debridx"); 
const TorrentMagnet = require("./torrentmagnet"); 
const External = require("./external"); 

// --- CONFIGURAZIONE NETWORK ---
const axiosInstance = axios.create({
    timeout: 8000, // Timeout ridotto per Vercel (max 10s totali su Hobby plan)
    headers: { 'User-Agent': 'Corsaro-Vercel/1.0.0' }
});

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); 

const app = express();
app.use(cors());
app.disable('x-powered-by'); 
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-vercel",
    version: "23.6.0", // Versione Vercel
    name: "Corsaro (Vercel Edition)",
    description: "🇮🇹 Cloud Edition. HTTPS Nativo + Anti-Ban.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: false } 
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

function isExactEpisodeMatch(torrentTitle, season, episode) {
    if (!torrentTitle) return false;
    const title = torrentTitle.toLowerCase();
    const s = season; const e = episode;
    const sStr = String(s).padStart(2, '0'); const eStr = String(e).padStart(2, '0');
    if (new RegExp(`s${sStr}[^0-9]*e${eStr}`, 'i').test(title)) return true;
    if (new RegExp(`\\b${s}x${eStr}\\b`, 'i').test(title)) return true;
    if (new RegExp(`stagione\\s*${s}(?!\\d)`, 'i').test(title) || 
        new RegExp(`s${sStr}\\s*(?:completa|pack|full)`, 'i').test(title)) {
        if (title.match(/e\d{2}/i) && !title.includes(`e${eStr}`)) return false; 
        return true;
    }
    return false;
}

function extractStreamInfo(title) {
    const t = (title || "").toLowerCase();
    let quality = "Unknown";
    if (t.includes("2160p") || t.includes("4k")) quality = "4k";
    else if (t.includes("1080p") || t.includes("fhd")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    let extra = [];
    if (t.includes("hdr") || t.includes("dolby vision")) extra.push("HDR");
    if (t.includes("hevc") || t.includes("x265")) extra.push("HEVC");
    return { quality, extraInfo: extra.join(" | ") };
}

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
            if (type === 'movie' && res.data.movie_results?.[0]) tmdbId = res.data.movie_results[0].id;
            else if (type === 'series' && res.data.tv_results?.[0]) tmdbId = res.data.tv_results[0].id;
        } else if (tmdbId.startsWith('tmdb:')) {
            tmdbId = tmdbId.split(':')[1];
        }
        const res = await axiosInstance.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${tmdbKey}&language=it-IT&append_to_response=alternative_titles,external_ids`);
        const details = res.data;
        const usefulAliases = (details.alternative_titles?.titles || []).filter(a => ['US', 'GB', 'ES', 'FR'].includes(a.iso_3166_1)).map(a => a.title);
        return {
            title: details.title || details.name,
            aliases: [...new Set([details.title || details.name, details.original_title || details.original_name, ...usefulAliases])],
            year: (details.release_date || details.first_air_date)?.split('-')[0],
            isSeries: type === 'series', 
            season: seasonNum, episode: episodeNum,
            imdb_id: details.external_ids?.imdb_id
        };
    } catch (e) { return null; }
}

// --- CORE LOGIC (OTTIMIZZATA PER VERCEL) ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, torbox, tmdb } = config || {}; 
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    // Cache hit immediato
    if (streamCache.has(cacheKey)) return streamCache.get(cacheKey);

    console.log(`🔍 Vercel Req: ${type} ${id}`);
    
    if ((!rd && !torbox) || !tmdb) return { streams: [{ title: "⚠️ Configurazione Mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata Error" }] };

        let queries = [];
        if (metadata.isSeries) {
            const s = metadata.season.toString().padStart(2, '0');
            const e = metadata.episode.toString().padStart(2, '0');
            queries.push(`${metadata.title} S${s}E${e}`); 
            if (metadata.aliases[1]) queries.push(`${metadata.aliases[1]} S${s}E${e}`);
        } else {
            queries.push(`${metadata.title} ${metadata.year}`); 
        }

        // 1. RICERCA SCRAPING (Max 4 secondi per stare nel limite Vercel)
        const safeSearch = (promise) => new Promise(r => { setTimeout(() => r([]), 4000); promise.then(r).catch(() => r([])); });
        let searchPromises = queries.slice(0, 2).map(q => safeSearch(TorrentMagnet.searchMagnet(q, metadata.isSeries ? null : metadata.year)));
        if (!filters.onlyIta) searchPromises.push(safeSearch(External.searchMagnet(id, type, metadata.imdb_id, queries[0])));

        const resultsArrays = await Promise.all(searchPromises);
        let allResults = resultsArrays.flat();

        let uniqueMap = new Map();
        for (const item of allResults) {
            if (!item || !item.magnet) continue;
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            if (!uniqueMap.has(key) || (item.seeders > uniqueMap.get(key).seeders)) uniqueMap.set(key, item);
        }
        let uniqueResults = Array.from(uniqueMap.values());

        uniqueResults = uniqueResults.filter(item => {
            if (metadata.isSeries && !isExactEpisodeMatch(item.title, metadata.season, metadata.episode)) return false;
            if (filters.onlyIta) {
                if (item.source?.includes("Corsaro")) return true;
                return /\b(ita|italian|italiano|multi|dual|md|sub[\s._-]?ita)\b/i.test((item.title || "").toLowerCase());
            }
            return true;
        });

        uniqueResults.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

        // ⚠️ LIMITIAMO A 12 PER VELOCITÀ VERCEL
        const topResults = uniqueResults.slice(0, 12); 

        // HELPER RESOLVER
        const processItem = async (item) => {
            try {
                let streamData = null;
                // Debrid check (più rapido possibile)
                if (torbox) { try { streamData = await DebridX.getStreamLink(config.torbox, item.magnet); } catch (e) {} }
                if (!streamData && rd) { try { streamData = await RD.getStreamLink(config.rd, item.magnet); } catch (e) {} }

                const fileTitle = streamData?.filename || item.title;
                const { quality, extraInfo } = extractStreamInfo(fileTitle);
                const finalSize = streamData?.size ? formatBytes(streamData.size) : (item.size || "??");
                
                let flagIcon = "🇬🇧"; let langLabel = "ENG";
                const lowT = fileTitle.toLowerCase(); const lowS = (item.source || "").toLowerCase();
                if (lowS.includes("corsaro") || /\b(ita|italian)\b/i.test(lowT)) { flagIcon = "🇮🇹"; langLabel = "ITA"; }
                else if (/\b(multi|dual)\b/i.test(lowT)) { flagIcon = "🌐"; langLabel = "MULTI"; }

                const titleStr = `📂 ${fileTitle}\n💾 ${finalSize} 👤 ${item.seeders}\n${flagIcon} ${langLabel} ${extraInfo}\n🔗 ${item.source}`;
                const nameLine = `${flagIcon} ${langLabel}\n${quality}`;

                if (streamData && streamData.url) {
                    return { name: nameLine, title: titleStr, url: streamData.url };
                } else if (filters.showFake) {
                    return {
                        name: nameLine,
                        description: "📥 Download to Debrid",
                        title: `${titleStr}\n❄️ UNCACHED (Click)`,
                        url: item.magnet,
                        behaviorHints: { notWebReady: true, bingeGroup: "uncached" }
                    };
                }
            } catch (err) { return null; }
            return null;
        };

        // BATCHING ADATTATO A VERCEL (Più veloce)
        // 4 per volta, pausa breve.
        const BATCH_SIZE = 4; 
        const finalStreams = [];

        for (let i = 0; i < topResults.length; i += BATCH_SIZE) {
            const batch = topResults.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(item => processItem(item)));
            finalStreams.push(...batchResults.filter(s => s !== null));
            if (i + BATCH_SIZE < topResults.length) await wait(250); // Pausa ridotta a 250ms per Vercel
        }

        const response = finalStreams.length ? { streams: finalStreams } : { streams: [] };
        streamCache.set(cacheKey, response);
        return response;

    } catch (error) {
        console.error("🔥 Error:", error.message);
        return { streams: [] };
    }
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifestBase };
    m.behaviorHints = { configurable: true, configurationRequired: false };
    m.logo = "https://dl.strem.io/addon-logo.png"; 
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
    res.setHeader('Cache-Control', 'public, max-age=60'); 
    res.json(streams);
});

// --- EXPORT PER VERCEL (IMPORTANTE!) ---
// Su Vercel non usiamo app.listen(), ma esportiamo l'app.
// In locale invece usiamo app.listen per testare.
const PORT = process.env.PORT || 7000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Addon running locally on port ${PORT}`);
    });
}

module.exports = app;
