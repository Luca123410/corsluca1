const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// Moduli interni
const RD = require("./rd");
const DebridX = require("./debridx");
const TorrentMagnet = require("./torrentmagnet"); // Il nuovo motore "Viola"
const External = require("./external");

// Configurazione Cache (importante per non sprecare esecuzioni serverless)
const streamCache = new NodeCache({ stdTTL: 600, checkperiod: 60 }); 

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Manifest
const manifestBase = {
    id: "org.community.corsaro-viola-method",
    version: "1.0.0",
    name: "Corsaro (Metodo Viola)",
    description: "Vercel Edition: Motore API-Based veloce e senza blocchi.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// Utilities
function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}

function getConfig(configStr) {
    try { 
        return JSON.parse(Buffer.from(configStr, 'base64').toString()); 
    } catch (e) { return {}; }
}

function extractQuality(title) {
    const t = (title || "").toLowerCase();
    if (t.includes("2160p") || t.includes("4k")) return "4K";
    if (t.includes("1080p")) return "1080p";
    if (t.includes("720p")) return "720p";
    return "SD";
}

// --- METADATA (TMDB) ---
async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        if (id.startsWith('tt')) {
            const find = await axios.get(`https://api.themoviedb.org/3/find/${id}?api_key=${tmdbKey}&external_source=imdb_id`);
            tmdbId = find.data[`${type}_results`]?.[0]?.id || id;
        }
        
        const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${tmdbKey}&language=it-IT`);
        const d = res.data;
        
        let season = 0, episode = 0;
        if (type === 'series' && id.includes(':')) {
            const p = id.split(':');
            season = parseInt(p[1]);
            episode = parseInt(p[2]);
        }

        return {
            title: d.title || d.name,
            year: (d.release_date || d.first_air_date)?.split('-')[0],
            isSeries: type === 'series',
            season, episode
        };
    } catch (e) { return null; }
}

// --- STREAM GENERATION ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, torbox, tmdb } = config || {};
    const cacheKey = `${id}-${userConfStr}`;
    
    if (streamCache.has(cacheKey)) return streamCache.get(cacheKey);
    if (!tmdb || (!rd && !torbox)) return { streams: [{ title: "⚠️ Configurazione mancante (TMDB/Debrid)" }] };

    try {
        const meta = await getMetadata(id, type, tmdb);
        if (!meta) return { streams: [{ title: "⚠️ Metadata error" }] };

        // Costruzione Query "Viola Style": Titolo + ITA
        let query = `${meta.title} ITA`;
        if (meta.isSeries) {
            // Cerca s01e01
            query = `${meta.title} S${String(meta.season).padStart(2,'0')}E${String(meta.episode).padStart(2,'0')} ITA`;
        } else {
            query = `${meta.title} ${meta.year} ITA`;
        }

        // Chiamata al nuovo motore
        const torrents = await TorrentMagnet.searchMagnet(query);
        
        // Ordina per seeders
        torrents.sort((a,b) => b.seeders - a.seeders);
        const top = torrents.slice(0, 20);

        let streams = [];
        for (const t of top) {
            let linkInfo = null;
            // Prova Debrid
            if (rd && !linkInfo) try { linkInfo = await RD.getStreamLink(rd, t.magnet); } catch(e){}
            if (torbox && !linkInfo) try { linkInfo = await DebridX.getStreamLink(torbox, t.magnet); } catch(e){}

            const quality = extractQuality(t.title);
            const size = linkInfo?.size ? formatBytes(linkInfo.size) : t.size;
            
            if (linkInfo) {
                streams.push({
                    name: `🇮🇹 ${t.source}\n${quality}`,
                    title: `${t.title}\n💾 ${size} 👤 ${t.seeders}`,
                    url: linkInfo.url
                });
            } else if (config.filters?.showFake) {
                streams.push({
                    name: `🇮🇹 ${t.source}\n${quality}`,
                    title: `❄️ [Download] ${t.title}\n💾 ${size}`,
                    url: t.magnet,
                    behaviorHints: { notWebReady: true }
                });
            }
        }

        const resp = { streams: streams.length ? streams : [{ title: "🚫 Nessun risultato ITA trovato" }] };
        streamCache.set(cacheKey, resp);
        return resp;

    } catch (e) {
        return { streams: [{ title: "Errore Vercel/Timeout" }] };
    }
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:conf/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifestBase);
});

app.get('/:conf/stream/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const streams = await generateStream(req.params.type, req.params.id.replace('.json',''), getConfig(req.params.conf), req.params.conf);
    res.json(streams);
});

// Vercel Export
module.exports = app;
