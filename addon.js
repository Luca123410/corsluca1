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

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 }); // 12 ore

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST BASE ---
const manifestBase = {
    id: "org.community.corsaro-ultimate",
    version: "22.6.0", 
    name: "Corsaro + Global (UNLEASHED)",
    description: "🇮🇹 L'esperienza definitiva per l'Italia. 🚀 5 Motori: Corsaro & UIndex (IT) + Global. ⚡ Real-Debrid Integrato. 🛡️ Filtri Smart e Rilevamento Audio/HDR avanzato.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// --- UTILITIES ---
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const REAL_SIZE_FILTER = 250 * 1024 * 1024; // 250MB

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

// --- ANALISI AVANZATA DEL FILE (NUOVO) ---
function extractStreamInfo(title) {
    const t = title.toLowerCase();
    let quality = "Unknown";
    
    // 1. Risoluzione
    if (t.includes("2160p") || t.includes("4k")) quality = "4k";
    else if (t.includes("1080p")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    else if (t.includes("dvdrip")) quality = "DVD";

    // 2. Canali Audio (Logica rubata a Orion)
    let channels = "";
    if (t.includes("7.1")) channels = "7.1";
    else if (t.includes("5.1") || t.includes("ac3") || t.includes("dd5") || t.includes("dd+")) channels = "5.1";
    else if (t.includes("aac") || t.includes("2.0") || t.includes("stereo")) channels = "2.0";

    // 3. Video Tech (HDR / x265)
    let videoExtras = [];
    if (t.includes("hdr") || t.includes("10bit")) videoExtras.push("HDR");
    if (t.includes("dv") || t.includes("dolby vision")) videoExtras.push("DV");
    if (t.includes("hevc") || t.includes("x265") || t.includes("h265")) videoExtras.push("HEVC");

    // 4. Lingue
    let lang = [];
    if (t.includes("ita") || t.includes("italian")) lang.push("ITA 🇮🇹");
    if (t.includes("multi") || t.includes("dual")) lang.push("MULTI 🌐");
    if (t.includes("eng") && !t.includes("ita") && !t.includes("multi")) lang.push("ENG 🇬🇧");
    
    // Costruiamo la stringa info extra
    let extraInfo = videoExtras.join(" | ");
    if (channels) extraInfo += (extraInfo ? ` | 🔊 ${channels}` : `🔊 ${channels}`);

    return { quality, lang, extraInfo };
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
            if (type === 'movie' && res.data.movie_results?.length > 0) details = res.data.movie_results[0];
            else if (type === 'series' && res.data.tv_results?.length > 0) details = res.data.tv_results[0];
        } else if (tmdbId.startsWith('tmdb:')) {
            const cleanId = tmdbId.split(':')[1];
            const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${cleanId}?api_key=${tmdbKey}&language=it-IT`);
            details = res.data;
        }
        if (details) {
            return {
                title: details.title || details.name, originalTitle: details.original_title || details.original_name, year: (details.release_date || details.first_air_date)?.split('-')[0],
                isSeries: type === 'series', season: seasonNum, episode: episodeNum
            };
        }
        return null;
    } catch (e) { return null; }
}

// --- CATALOGO ---
async function generateCatalog(type, id, config) {
    const cacheKey = `catalog:${type}:${id}`;
    if (catalogCache.has(cacheKey)) {
        console.log(`📦 CATALOGO CACHED: ${id}`);
        return catalogCache.get(cacheKey);
    }
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

// --- STREAM HANDLER ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, tmdb } = config || {};
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE: ${id}`);
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione Dashboard incompleta" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        let searchBase;
        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            const e = String(metadata.episode).padStart(2, '0');
            searchBase = `${metadata.title} S${s}E${e}`;
        } else {
            searchBase = `${metadata.title} ${metadata.year}`;
        }

        // RICERCA PENTA
        let promises = [
            Corsaro.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            UIndex.searchMagnet(searchBase, metadata.year).catch(()=>[])
        ];

        if (!filters.onlyIta) {
            promises.push(Apibay.searchMagnet(searchBase, metadata.year).catch(()=>[]));
            promises.push(TorrentMagnet.searchMagnet(searchBase, metadata.year).catch(()=>[]));
        }

        const resultsArray = await Promise.all(promises);
        let allResults = resultsArray.flat();

        // Fallback Titolo Originale
        if (allResults.length === 0 && metadata.title !== metadata.originalTitle) {
            const searchBaseOrig = metadata.isSeries ? 
                `${metadata.originalTitle} S${String(metadata.season).padStart(2, '0')}E${String(metadata.episode).padStart(2, '0')}` : 
                `${metadata.originalTitle} ${metadata.year}`;
            
            let promisesOrig = [
                Corsaro.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                UIndex.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[])
            ];
            if (!filters.onlyIta) {
                promisesOrig.push(Apibay.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]));
                promisesOrig.push(TorrentMagnet.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]));
            }
            const resultsOrig = await Promise.all(promisesOrig);
            allResults = [...allResults, ...resultsOrig.flat()];
        }

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

        // APPLICAZIONE FILTRI
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
                
                // --- NEW: EXTRA INFO (HDR, 5.1, ETC) ---
                const { quality, lang, extraInfo } = extractStreamInfo(fileTitle);
                
                let displayLang = lang.join(" / ");
                if (!displayLang) {
                     if (item.source === "Corsaro" || item.source === "UIndex") displayLang = "ITA 🇮🇹";
                     else displayLang = "MULTI / ENG 🌐";
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
                // Aggiunge Info Extra se presenti (Es: | HEVC | 🔊 5.1)
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
                } else {
                    if (filters.showFake) {
                        streams.push({
                            name: nameTag.replace('⚡', '⚠️'),
                            title: `${titleStr}\n⚠️ Link Diretto (Timeout/Errore RD)`,
                            url: item.magnet,
                            behaviorHints: { notWebReady: true }
                        });
                    }
                }
                await wait(50); 
            } catch (e) {}
        }

        const finalResponse = streams.length === 0 ? { streams: [{ title: "🚫 Nessun file valido (Prova a cambiare filtri)" }] } : { streams };
        streamCache.set(cacheKey, finalResponse);
        return finalResponse;
    } catch (error) {
        console.error("🔥 Errore fatale:", error.message);
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
app.listen(PORT, () => console.log(`Addon Unleashed v22.6.0 avviato su porta ${PORT}!`));
