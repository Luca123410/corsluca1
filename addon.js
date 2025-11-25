const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI ESTERNI ---
// Ho mantenuto solo quelli sicuri che avevi nell'altro file.
// Se hai anche gli altri file, puoi riaggiungerli qui.
const RD = require("./rd");
const TorrentMagnet = require("./torrentmagnet"); 

// --- CONFIGURAZIONE NETWORK (VPS OPTIMIZED) ---
// Timeout aumentato a 20s perché su VPS non abbiamo fretta come su Vercel
const axiosInstance = axios.create({
    timeout: 20000, 
    headers: { 'User-Agent': 'Corsaro-VPS/1.0' }
});

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 Minuti cache

const app = express();
app.use(cors());
app.disable('x-powered-by'); 
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-vps",
    version: "23.7.0", 
    name: "Corsaro (VPS Edition)",
    description: "🇮🇹 Cloud Edition. Ottimizzato per Server/VPS.",
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
        return {
            rd: config.rd,
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
    if (t.includes("2160p") || t.includes("4k")) quality = "4K UHD";
    else if (t.includes("1080p") || t.includes("fhd")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    
    let extra = [];
    if (t.includes("hdr") || t.includes("dolby vision")) extra.push("HDR");
    if (t.includes("hevc") || t.includes("x265")) extra.push("HEVC");
    return { quality, extraInfo: extra.join(" | ") };
}

// --- METADATA (TMDB) ---
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

        const rawAliases = details.alternative_titles ? (details.alternative_titles.titles || details.alternative_titles.results || []) : [];
        const usefulAliases = rawAliases.filter(a => ['US', 'GB', 'ES', 'FR'].includes(a.iso_3166_1)).map(a => a.title);

        return {
            title: details.title || details.name,
            aliases: [...new Set([details.title || details.name, details.original_title || details.original_name, ...usefulAliases])],
            year: (details.release_date || details.first_air_date)?.split('-')[0],
            isSeries: type === 'series', 
            season: seasonNum, episode: episodeNum,
            imdb_id: details.external_ids?.imdb_id
        };
    } catch (e) { console.log("Meta Error", e.message); return null; }
}

// --- GENERAZIONE STREAM (VPS LOGIC) ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, tmdb } = config || {}; 
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    // 1. Controllo Cache
    if (streamCache.has(cacheKey)) {
        console.log(`🚀 Cache Hit: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`🔍 VPS Request: ${type} ${id}`);
    
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione Mancante\nInserisci API Key" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata Error" }] };

        let queries = [];
        if (metadata.isSeries) {
            const s = metadata.season.toString().padStart(2, '0');
            const e = metadata.episode.toString().padStart(2, '0');
            queries.push(`${metadata.title} S${s}E${e}`); 
            // Aggiungiamo query più specifiche
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
        } else {
            queries.push(`${metadata.title} ${metadata.year}`); 
            queries.push(`${metadata.title} ITA`);
        }

        // 2. Ricerca Torrent (Senza limiti di tempo stretti)
        let searchPromises = queries.map(q => TorrentMagnet.searchMagnet(q, metadata.isSeries ? null : metadata.year).catch(() => []));
        
        const resultsArrays = await Promise.all(searchPromises);
        let allResults = resultsArrays.flat();

        // 3. Deduplicazione
        let uniqueMap = new Map();
        for (const item of allResults) {
            if (!item || !item.magnet) continue;
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            
            if (!uniqueMap.has(key) || (item.seeders > uniqueMap.get(key).seeders)) {
                uniqueMap.set(key, item);
            }
        }
        let uniqueResults = Array.from(uniqueMap.values());

        // 4. Filtri Pre-Debrid
        uniqueResults = uniqueResults.filter(item => {
            if (metadata.isSeries && !isExactEpisodeMatch(item.title, metadata.season, metadata.episode)) return false;
            if (filters.onlyIta) {
                const t = (item.title || "").toLowerCase();
                if (item.source?.includes("Corsaro")) return true;
                return /\b(ita|italian|italiano|multi|dual|md|sub[\s._-]?ita)\b/i.test(t);
            }
            return true;
        });

        // 5. Ordinamento e Selezione
        uniqueResults.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

        // VPS POWER: Controlliamo fino a 30 risultati (Addon 8 ne controllava solo 6)
        const topResults = uniqueResults.slice(0, 30); 

        console.log(`⚡ Risoluzione Debrid per ${topResults.length} items...`);

        // 6. Risoluzione Debrid
        const streamPromises = topResults.map(async (item) => {
            try {
                let streamData = null;
                // Prova Real-Debrid
                if (rd) { 
                    try { streamData = await RD.getStreamLink(config.rd, item.magnet); } 
                    catch (e) { if(e.message.includes('429')) await new Promise(r => setTimeout(r, 500)); } 
                }

                if (!streamData) return null;

                const fileTitle = streamData.filename || item.title;
                const { quality, extraInfo } = extractStreamInfo(fileTitle);
                const finalSize = streamData.size ? formatBytes(streamData.size) : (item.size || "??");
                
                let flagIcon = "🇬🇧"; let langLabel = "ENG";
                const lowerTitle = fileTitle.toLowerCase();
                const lowerSource = (item.source || "").toLowerCase();
                
                if (lowerSource.includes("corsaro") || /\b(ita|italian)\b/i.test(lowerTitle)) { 
                    flagIcon = "🇮🇹"; langLabel = "ITA"; 
                } else if (/\b(multi|dual)\b/i.test(lowerTitle)) { 
                    flagIcon = "🌐"; langLabel = "MULTI"; 
                }

                const titleStr = `📂 ${fileTitle}\n💾 ${finalSize} 👤 ${item.seeders || 0}\n${flagIcon} ${langLabel} ${extraInfo}\n🔗 ${item.source || "P2P"}`;
                const nameLine = `[RD] ${langLabel}\n${quality}`;

                if (streamData.url) {
                    return { name: nameLine, title: titleStr, url: streamData.url };
                }
            } catch (err) { return null; }
            return null;
        });

        const resolvedStreams = await Promise.all(streamPromises);
        const finalStreams = resolvedStreams.filter(s => s !== null);

        console.log(`✅ Streams pronti: ${finalStreams.length}`);

        const response = finalStreams.length ? { streams: finalStreams } : { streams: [] };
        streamCache.set(cacheKey, response);
        return response;

    } catch (error) {
        console.error("🔥 Critical Error:", error.message);
        return { streams: [] };
    }
}

// --- ROUTING ---
app.get('/', (req, res) => res.send('Corsaro VPS is Running 🚀'));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifestBase };
    
    // Auto-configurazione se i dati ci sono
    if (config.rd && config.tmdb) {
        m.behaviorHints.configurationRequired = false;
    }
    
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
    // Cache breve browser per fluidità
    res.setHeader('Cache-Control', 'public, max-age=60'); 
    res.json(streams);
});

// --- SERVER START (VPS MODE) ---
// Questa è la parte cruciale che mancava:
const PORT = process.env.PORT || 7000;

app.listen(PORT, () => {
    console.log(`🚀 Addon (VPS Edition) avviato sulla porta ${PORT}`);
    console.log(`   http://localhost:${PORT}/manifest.json`);
});
