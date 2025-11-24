
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");
const http = require('http');
const https = require('https');

// --- MODULI ESTERNI ---
const RD = require("./rd");
const DebridX = require("./debridx"); 
const TorrentMagnet = require("./torrentmagnet"); 
const External = require("./external"); 

// --- ANTI-BLOCKING ---
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const axiosInstance = axios.create({
    timeout: 9000, // Timeout ridotto per Vercel
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' }
});

axiosInstance.interceptors.request.use(config => {
    config.headers['User-Agent'] = getRandomUA();
    return config;
});

// --- CACHE ---
const streamCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); 

const app = express();
app.use(cors());
app.disable('x-powered-by'); 
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-vercel",
    version: "23.5.6",
    name: "Corsaro Vercel Edition",
    description: "V23.5.6: Vercel Optimized (No Proxy Required)",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// --- UTILITIES ---
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
        return { rd: config.rd, torbox: config.torbox, tmdb: config.tmdb, filters: config.filters || {} };
    } catch (e) { return {}; }
}

function extractStreamInfo(title) {
    const t = (title || "").toLowerCase();
    let quality = "Unknown";
    if (t.includes("2160p") || t.includes("4k")) quality = "4k";
    else if (t.includes("1080p")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    return { quality };
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
            if (type === 'movie' && res.data.movie_results?.[0]) tmdbId = res.data.movie_results[0].id;
            else if (type === 'series' && res.data.tv_results?.[0]) tmdbId = res.data.tv_results[0].id;
        }

        const res = await axiosInstance.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${tmdbKey}&language=it-IT&append_to_response=alternative_titles`);
        const details = res.data;

        if (details) {
            const usefulAliases = (details.alternative_titles?.results || []).filter(a => ['US', 'GB'].includes(a.iso_3166_1)).map(a => a.title);
            let aliases = [details.title || details.name, details.original_title || details.original_name, ...usefulAliases];
            return {
                title: details.title || details.name,
                aliases: [...new Set(aliases.filter(Boolean))],
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

    if (streamCache.has(cacheKey)) return streamCache.get(cacheKey);
    if ((!rd && !torbox) || !tmdb) return { streams: [{ title: "⚠️ Configurazione Mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        let query = "";
        if (metadata.isSeries) {
            const s = metadata.season.toString().padStart(2, '0');
            const e = metadata.episode.toString().padStart(2, '0');
            query = `${metadata.title} S${s}E${e}`;
        } else {
            query = `${metadata.title} ${metadata.year}`;
        }

        // RICERCA OTTIMIZZATA PER VERCEL
        // Usiamo solo 1 query principale per risparmiare tempo
        const results = await TorrentMagnet.searchMagnet(query, metadata.isSeries ? null : metadata.year);
        
        // Filtri base
        let uniqueResults = results.filter(item => {
            if (filters.onlyIta) {
                const t = (item.title || "").toLowerCase();
                const s = (item.source || "").toLowerCase();
                if (s.includes("corsaro")) return true;
                return /\b(ita|italian|italiano|multi)\b/i.test(t);
            }
            return true;
        });

        // Ordinamento Seeders
        uniqueResults.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
        const topResults = uniqueResults.slice(0, 30); 

        let streams = [];
        for (const item of topResults) {
            let streamData = null;
            if (torbox) try { streamData = await DebridX.getStreamLink(config.torbox, item.magnet); } catch (e) {}
            if (!streamData && rd) try { streamData = await RD.getStreamLink(config.rd, item.magnet); } catch (e) {}
            
            const fileTitle = streamData?.filename || item.title || "Unknown";
            const { quality } = extractStreamInfo(fileTitle);
            const size = streamData?.size ? formatBytes(streamData.size) : (item.size || "??");
            
            const nameLine = `🇮🇹 ${item.source}\n${quality}`;
            const titleStr = `${fileTitle}\n💾 ${size} 👤 ${item.seeders}`;

            if (streamData) {
                streams.push({ name: nameLine, title: titleStr, url: streamData.url });
            } else if (filters.showFake) {
                streams.push({ name: nameLine, title: `❄️ [Download] ${titleStr}`, url: item.magnet, behaviorHints: { notWebReady: true } });
            }
        }

        const finalResponse = { streams: streams.length ? streams : [{ title: "🚫 Nessun risultato trovato" }] };
        streamCache.set(cacheKey, finalResponse, 600);
        return finalResponse;

    } catch (error) { return { streams: [{ title: "Errore Vercel" }] }; }
}

// --- ROUTING VERCEL ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifestBase };
    if ((config.tmdb && config.rd) || (config.tmdb && config.torbox)) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});

app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const streams = await generateStream(req.params.type, req.params.id.replace('.json', ''), getConfig(req.params.userConf), req.params.userConf);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300'); 
    res.json(streams);
});

// LOGICA AVVIO: Se locale usa listen, se Vercel esporta app
const PORT = process.env.PORT || 7000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Locale attivo su porta ${PORT}`));
}
module.exports = app;
