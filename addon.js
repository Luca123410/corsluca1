const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI ESTERNI ---
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");
const TorrentMagnet = require("./torrentmagnet");
const UIndex = require("./uindex"); 
const External = require("./external"); 

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); 
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 }); 

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-ita-strict",
    version: "23.3.0", 
    name: "Corsaro + Global (ITA STRICT)",
    description: "🇮🇹 V23.3: Filtro 'Zero Tolleranza'. Le fonti Globali/Torrentio vengono mostrate SOLO se contengono esplicitamente la tag ITA. I file 'Multi' generici vengono scartati per sicurezza.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// --- UTILITIES ---
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const REAL_SIZE_FILTER = 200 * 1024 * 1024; 

function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } catch (e) { return {}; }
}

// --- 🧠 SMART MATCHING LOGIC ---
function isExactEpisodeMatch(torrentTitle, season, episode) {
    if (!torrentTitle) return false;
    const title = torrentTitle.toLowerCase();
    const s = season;
    const e = episode;
    const sStr = String(s).padStart(2, '0');
    const eStr = String(e).padStart(2, '0');

    const exactPatterns = [
        new RegExp(`s${sStr}e${eStr}`, 'i'),
        new RegExp(`${s}x${eStr}`, 'i'),
        new RegExp(`s${sStr}\\.?e${eStr}`, 'i')
    ];
    if (exactPatterns.some(p => p.test(title))) return true;

    const rangePattern = new RegExp(`s${sStr}e(\\d{1,2})\\s*[-–—]\\s*e?(\\d{1,2})`, 'i');
    const rangeMatch = title.match(rangePattern);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        if (e >= start && e <= end) return true;
    }

    const packPatterns = [
        new RegExp(`stagione\\s*${s}(?!\\d)`, 'i'),
        new RegExp(`season\\s*${s}(?!\\d)`, 'i'),
        new RegExp(`s${sStr}\\s*(?:completa|complete|pack)`, 'i'),
        new RegExp(`s${sStr}\\s*$`, 'i')
    ];
    if (packPatterns.some(p => p.test(title))) return true;

    return false;
}

function extractStreamInfo(title) {
    const t = title.toLowerCase();
    let quality = "Unknown";
    if (t.includes("2160p") || t.includes("4k")) quality = "4k";
    else if (t.includes("1080p")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    else if (t.includes("dvdrip")) quality = "DVD";

    let extra = [];
    if (t.includes("hdr") || t.includes("10bit")) extra.push("HDR");
    if (t.includes("dolby") || t.includes("vision")) extra.push("DV");
    if (t.includes("hevc") || t.includes("x265")) extra.push("HEVC");
    if (t.includes("5.1") || t.includes("ac3")) extra.push("5.1");

    let lang = [];
    if (t.includes("ita") || t.includes("italian")) lang.push("ITA 🇮🇹");
    // Nota: Rimuoviamo "Multi" da qui perché ora accettiamo solo se c'è anche ITA
    if (t.includes("multi") || t.includes("dual")) lang.push("MULTI 🌐");
    
    return { quality, lang, extraInfo: extra.join(" | ") };
}

async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        let seasonNum, episodeNum;
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0]; seasonNum = parseInt(parts[1]); episodeNum = parseInt(parts[2]);
        }
        let details;
        if (tmdbId.startsWith('tt')) {
            const res = await axios.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
            if (type === 'movie') details = res.data.movie_results[0];
            else details = res.data.tv_results[0];
        } else if (tmdbId.startsWith('tmdb:')) {
            const cleanId = tmdbId.split(':')[1];
            const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${cleanId}?api_key=${tmdbKey}&language=it-IT`);
            details = res.data;
        }
        if (details) {
            return {
                title: details.title || details.name, 
                originalTitle: details.original_title || details.original_name, 
                year: (details.release_date || details.first_air_date)?.split('-')[0],
                isSeries: type === 'series', season: seasonNum, episode: episodeNum,
                imdb_id: tmdbId.startsWith('tt') ? tmdbId : null 
            };
        }
        return null;
    } catch (e) { return null; }
}

// --- CATALOGO ---
async function generateCatalog(type, id, config) {
    const cacheKey = `catalog:${type}:${id}`;
    if (catalogCache.has(cacheKey)) return catalogCache.get(cacheKey);

    if (id === "tmdb_trending" && config.tmdb) {
        try {
            const r = await axios.get(`https://api.themoviedb.org/3/trending/movie/day?api_key=${config.tmdb}&language=it-IT`);
            const result = { metas: r.data.results.map(m => ({
                id: `tmdb:${m.id}`, type: "movie", name: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`
            }))};
            catalogCache.set(cacheKey, result);
            return result;
        } catch (e) { return { metas: [] }; }
    }
    return { metas: [] };
}

// --- STREAM HANDLER (ITA STRICT) ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, tmdb } = config || {};
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE (V23.3 Strict ITA): ${id}`);
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        // --- QUERY GENERATION ---
        let queries = [];
        
        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            const e = String(metadata.episode).padStart(2, '0');
            queries.push(`${metadata.title} S${s}E${e}`);
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
            
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} S${s}E${e}`);
                queries.push(`${metadata.originalTitle} Season ${metadata.season}`);
            }
        } else {
            queries.push(`${metadata.title} ${metadata.year}`);
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ${metadata.year}`);
            }
        }
        queries = [...new Set(queries)];

        // --- HEXA-SEARCH PARALLELA ---
        let promises = [];

        // 1. Fonti Italiane Sicure
        queries.forEach(q => {
            promises.push(Corsaro.searchMagnet(q, metadata.year).catch(()=>[]));
            promises.push(UIndex.searchMagnet(q, metadata.year).catch(()=>[]));
        });

        // 2. Fonti Globali
        if (!filters.onlyIta) {
            promises.push(Apibay.searchMagnet(queries[0], metadata.year).catch(()=>[]));
            promises.push(TorrentMagnet.searchMagnet(queries[0], metadata.year).catch(()=>[]));
            promises.push(External.searchMagnet(id, type).catch(()=>[]));
        }

        const resultsArray = await Promise.all(promises);
        let allResults = resultsArray.flat();

        if (allResults.length === 0) return { streams: [{ title: `🚫 Nessun risultato trovato` }] };

        // DEDUPLICAZIONE
        let uniqueResults = [];
        const magnetSet = new Set();
        for (const item of allResults) {
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            if (!magnetSet.has(key)) {
                magnetSet.add(key);
                uniqueResults.push(item);
            }
        }

        // --- 🛡️ STRICT ITA FILTER ---
        uniqueResults = uniqueResults.filter(item => {
            // 1. Check Episodio (Se serie TV)
            if (metadata.isSeries) {
                const isTrustedSource = item.source.includes("Tio") || item.source.includes("Torrentio");
                if (!isTrustedSource && !isExactEpisodeMatch(item.title, metadata.season, metadata.episode)) {
                    return false;
                }
            }

            // 2. Check Fonte Sicura (Italia)
            const isItalianSource = item.source === "Corsaro" || item.source === "UIndex" || item.source === "IlCorsaroNero";
            if (isItalianSource) return true; // Passa sempre

            // 3. Check Fonte Globale (Stretta)
            // Deve contenere esplicitamente "ITA" o "ITALIAN".
            // "MULTI" DA SOLO VIENE SCARTATO.
            const t = item.title.toLowerCase();
            // Regex per evitare falsi positivi come "digITAL"
            const hasStrictIta = /\b(ita|italian)\b/i.test(t);

            if (hasStrictIta) return true; // Passa solo se c'è scritto ITA

            return false; // Scarta tutto il resto (incluso Multi generico)
        });

        // Filtri Tecnici
        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) {
            const bad = ['cam', 'dvdscr', 'hdcam', 'telesync', 'tc', 'ts'];
            uniqueResults = uniqueResults.filter(i => !bad.some(q => i.title.toLowerCase().includes(q)));
        }

        uniqueResults.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
        const topResults = uniqueResults.slice(0, 20); 

        // VERIFICA RD
        let streams = [];
        for (const item of topResults) {
            try {
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                if (streamData && streamData.type === 'ready' && streamData.size < REAL_SIZE_FILTER) continue; 

                const fileTitle = streamData?.filename || item.title;
                const { quality, lang, extraInfo } = extractStreamInfo(fileTitle);
                
                let displayLang = lang.join(" / ");
                if (!displayLang) {
                     if (item.source === "Corsaro" || item.source === "UIndex") displayLang = "ITA 🇮🇹";
                     else displayLang = "ITA (Global) 🌐"; // Se è passato, è perché aveva la tag ITA
                }

                let nameTag = `[RD ⚡] ${item.source}`;
                if (!streamData) nameTag = `[RD ⏳] ${item.source}`;
                nameTag += `\n${quality}`;

                let finalSize = streamData?.size ? formatBytes(streamData.size) : (item.size || "?? GB");
                if (!streamData) {
                     if(finalSize.includes("MB") && parseInt(finalSize) < 100) finalSize = "?? GB";
                     if(finalSize.toLowerCase().endsWith("b") && !finalSize.toLowerCase().includes("k")) finalSize = "?? GB";
                }

                let titleStr = `📄 ${fileTitle}\n`;
                titleStr += `💾 ${finalSize}`;
                if (extraInfo) titleStr += ` | ${extraInfo}`;
                titleStr += `\n⚙️ ${item.source}\n`;
                titleStr += `🔊 ${displayLang}`;

                if (streamData) {
                    streams.push({
                        name: nameTag,
                        title: titleStr,
                        url: streamData.url,
                        behaviorHints: { notWebReady: false }
                    });
                } else if (filters.showFake) {
                    streams.push({
                        name: nameTag.replace('⚡', '⚠️'),
                        title: `${titleStr}\n⚠️ Link Diretto (Download Richiesto)`,
                        url: item.magnet,
                        behaviorHints: { notWebReady: true }
                    });
                }
                await wait(50); 
            } catch (e) {}
        }

        const finalResponse = streams.length === 0 ? { streams: [{ title: "🚫 Nessun file ITA sicuro trovato." }] } : { streams };
        streamCache.set(cacheKey, finalResponse);
        return finalResponse;
    } catch (error) {
        console.error("🔥 Errore fatale:", error.message);
        return { streams: [{ title: "Errore Interno Addon" }] };
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
    if (config.tmdb && config.rd) m.behaviorHints = { configurable: true, configurationRequired: false };
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
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.json(streams);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ITA Strict v23.3.0 avviato su porta ${PORT}!`));
