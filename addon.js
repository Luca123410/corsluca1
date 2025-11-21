const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI ESTERNI ---
const RD = require("./rd");
const DebridX = require("./debridx"); // 1. NUOVO: Importazione del modulo DebridX (Torbox)
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");
const TorrentMagnet = require("./torrentmagnet");
const UIndex = require("./uindex"); 
const External = require("./external"); 

// --- CONFIGURAZIONE CACHE ---
// stdTTL globale a 900 (15 min), ma lo sovrascriveremo dinamicamente
const streamCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); 
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 }); 

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-alias-hunter",
    version: "23.4.2", // Bump versione per forzare aggiornamento (Versione 23.4.2 con Torbox)
    name: "Corsaro + Global (ALIAS HUNTER)",
    description: "🇮🇹 V23.4.2: Motore Alias Hunter con Caching Intelligente. Supporto Multi-Debrid (RD + Torbox). Filtro ITA Strict + 7 Motori.",
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
    try { 
        // 2. AGGIORNATO: Aggiunge la chiave 'torbox' alla configurazione
        const config = JSON.parse(Buffer.from(configStr, 'base64').toString()); 
        return {
            rd: config.rd,
            torbox: config.torbox, // Nuova chiave Torbox
            tmdb: config.tmdb,
            filters: config.filters || {}
        };
    } catch (e) { return {}; }
}

// --- 🧠 SMART MATCHING LOGIC ---
function isExactEpisodeMatch(torrentTitle, season, episode) {
    if (!torrentTitle) return false;
    const title = torrentTitle.toLowerCase();
    const s = season;
    const e = episode;
    const sStr = String(s).padStart(2, '0');
    const eStr = String(e).padStart(2, '0');

    // 1. Match Esatto
    const exactPatterns = [
        new RegExp(`s${sStr}e${eStr}`, 'i'),
        new RegExp(`${s}x${eStr}`, 'i'),
        new RegExp(`s${sStr}\\.?e${eStr}`, 'i')
    ];
    if (exactPatterns.some(p => p.test(title))) return true;

    // 2. Match Range (S01E01-10)
    const rangePattern = new RegExp(`s${sStr}e(\\d{1,2})\\s*[-–—]\\s*e?(\\d{1,2})`, 'i');
    const rangeMatch = title.match(rangePattern);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        if (e >= start && e <= end) return true;
    }

    // 3. Match Season Pack
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
    if (t.includes("ita")) lang.push("ITA 🇮🇹");
    if (t.includes("multi") || t.includes("dual")) lang.push("MULTI 🌐");
     
    return { quality, lang, extraInfo: extra.join(" | ") };
}

// --- 🕵️ ALIAS HUNTER METADATA ---
async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        let seasonNum, episodeNum;
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0]; seasonNum = parseInt(parts[1]); episodeNum = parseInt(parts[2]);
        }
        
        // Risoluzione ID tt... -> tmdb...
        if (tmdbId.startsWith('tt')) {
            const res = await axios.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
            if (type === 'movie' && res.data.movie_results[0]) tmdbId = res.data.movie_results[0].id;
            else if (type === 'series' && res.data.tv_results[0]) tmdbId = res.data.tv_results[0].id;
        } else if (tmdbId.startsWith('tmdb:')) {
            tmdbId = tmdbId.split(':')[1];
        }

        // Richiesta Dettagli + Alternative Titles
        const append = "alternative_titles,external_ids";
        const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}?api_key=${tmdbKey}&language=it-IT&append_to_response=${append}`);
        const details = res.data;

        if (details) {
            // Estrazione Alias (US, UK, ES, FR)
            const rawAliases = details.alternative_titles ? (details.alternative_titles.titles || details.alternative_titles.results || []) : [];
            const usefulAliases = rawAliases
                .filter(a => ['US', 'GB', 'ES', 'FR'].includes(a.iso_3166_1))
                .map(a => a.title);

            // Lista Alias: [Titolo ITA, Originale, Inglese...]
            let aliases = [details.title || details.name, details.original_title || details.original_name, ...usefulAliases];
            aliases = [...new Set(aliases.filter(Boolean))]; // Deduplica

            return {
                title: details.title || details.name, // Titolo Italiano principale
                aliases: aliases, // Lista completa per la ricerca
                year: (details.release_date || details.first_air_date)?.split('-')[0],
                isSeries: type === 'series', season: seasonNum, episode: episodeNum,
                imdb_id: details.external_ids?.imdb_id
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

// --- STREAM HANDLER ---
async function generateStream(type, id, config, userConfStr) {
    // Aggiornato: usa sia rd che torbox
    const { rd, torbox, tmdb } = config || {}; 
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE (V23.4 Alias Hunter): ${id}`);
    if (!rd && !torbox || !tmdb) return { streams: [{ title: "⚠️ Configurazione (RD/Torbox/TMDB) mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        // --- QUERY GENERATION (ALIAS HUNTER) ---
        let queries = [];
        const searchTitles = metadata.aliases.slice(0, 3); 

        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            const e = String(metadata.episode).padStart(2, '0');
             
            searchTitles.forEach(t => {
                queries.push(`${t} S${s}E${e}`);
                queries.push(`${t} Season ${metadata.season}`);
            });
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
        } else {
            searchTitles.forEach(t => {
                queries.push(`${t} ${metadata.year}`);
            });
        }
        queries = [...new Set(queries)];
        console.log(`   🔍 Queries: ${JSON.stringify(queries)}`);

        // --- PARALLEL SEARCH ---
        let promises = [];

        // 1. Corsaro & UIndex (ITA)
        queries.forEach(q => {
            promises.push(Corsaro.searchMagnet(q, metadata.year).catch(()=>[]));
            promises.push(UIndex.searchMagnet(q, metadata.year).catch(()=>[]));
        });

        if (!filters.onlyIta) {
            // 2. Globali Nativi (Apibay, TM)
            promises.push(Apibay.searchMagnet(queries[0], metadata.year).catch(()=>[]));
            promises.push(TorrentMagnet.searchMagnet(queries[0], metadata.year).catch(()=>[]));
             
            // 3. Meta-Scrapers (Torrentio, etc)
            promises.push(External.searchMagnet(id, type).catch(()=>[]));
        }

        const resultsArray = await Promise.all(promises);
        let allResults = resultsArray.flat();

        // SE NON TROVIAMO NULLA -> Return rapido ma con Cache breve gestita alla fine
        if (allResults.length === 0) {
            // Continuiamo l'esecuzione per arrivare al blocco finale di caching
            // o possiamo saltare direttamente a fine funzione, ma usiamo l'array vuoto
        }

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

        // --- 🛡️ FILTRO ITA STRICT ---
        uniqueResults = uniqueResults.filter(item => {
            if (metadata.isSeries) {
                const isTrustedSource = ["Tio", "Torrentio", "KC", "MF", "MediaFusion"].some(s => item.source.includes(s));
                if (!isTrustedSource && !isExactEpisodeMatch(item.title, metadata.season, metadata.episode)) {
                    return false;
                }
            }
            const isItalianSource = ["Corsaro", "UIndex", "IlCorsaroNero"].some(s => item.source.includes(s));
            if (isItalianSource) return true;
            const t = item.title.toLowerCase();
            const hasSafeTag = /\b(ita|italian|multi|dual)\b/i.test(t);
            if (hasSafeTag) return true;
            return false; 
        });

        // Filtri Tecnici
        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) {
            const bad = ['cam', 'dvdscr', 'hdcam', 'telesync', 'tc', 'ts'];
            uniqueResults = uniqueResults.filter(i => !bad.some(q => i.title.toLowerCase().includes(q)));
        }

        uniqueResults.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
        const topResults = uniqueResults.slice(0, 25); 

        // VERIFICA DEBRID (RD + TORBOX)
        let streams = [];
        for (const item of topResults) {
            let streamData = null;
            let debridService = null;
            
            // 3. NUOVO: Prova prima Torbox, poi Real Debrid
            if (torbox) {
                try {
                    streamData = await DebridX.getStreamLink(config.torbox, item.magnet);
                    if (streamData) debridService = 'Torbox 🌐';
                } catch (e) { /* Fallthrough a RD */ }
            }

            if (!streamData && rd) {
                try {
                    streamData = await RD.getStreamLink(config.rd, item.magnet);
                    if (streamData) debridService = 'RD ⚡';
                } catch (e) { /* Continua */ }
            }
            
            // Se il file è troppo piccolo, ignoralo
            if (streamData && streamData.type === 'ready' && streamData.size < REAL_SIZE_FILTER) continue; 

            const fileTitle = streamData?.filename || item.title;
            const { quality, lang, extraInfo } = extractStreamInfo(fileTitle);
            
            let displayLang = lang.join(" / ");
            if (!displayLang) {
                  if (["Corsaro", "UIndex"].some(s => item.source.includes(s))) displayLang = "ITA 🇮🇹";
                  else displayLang = "ITA/MULTI 🌐"; 
            }

            let nameTag = `[${debridService || '⏳'}] ${item.source}`;
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
                    name: nameTag.replace('⚡', '⚠️').replace('🌐', '⚠️').replace('⏳', '⚠️'),
                    title: `${titleStr}\n⚠️ Link Diretto (Download Richiesto)`,
                    url: item.magnet,
                    behaviorHints: { notWebReady: true }
                });
            }
            await wait(50); 
        }

        const finalResponse = streams.length === 0 
            ? { streams: [{ title: "🚫 Nessun file ITA trovato." }] } 
            : { streams };

        // --- INTELLIGENT CACHING STRATEGY ---
        // 1. Se abbiamo URL validi (file trovati su RD) -> Cache Lunga (15 min / 900s)
        // 2. Se non abbiamo nulla -> Cache Breve (2 min / 120s) per permettere retry
        const hasValidLinks = streams.some(s => s.url);
        const dynamicTTL = hasValidLinks ? 900 : 120;

        console.log(`💾 Caching Result per ${id}: ${dynamicTTL} secondi (Items: ${streams.length})`);
        streamCache.set(cacheKey, finalResponse, dynamicTTL);

        return finalResponse;
    } catch (error) {
        console.error("🔥 Errore fatale:", error.message);
        // In caso di errore critico, cachiamo l'errore per solo 60 secondi
        const errorResp = { streams: [{ title: "Errore Interno" }] };
        streamCache.set(cacheKey, errorResp, 60); 
        return errorResp;
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
    // Aggiornato per richiedere almeno una chiave debrid + tmdb
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
    
    // --- CLIENT SIDE CACHING ---
    res.setHeader('Cache-Control', 'public, max-age=120'); 
    
    res.json(streams);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon Alias Hunter v23.4.2 (Smart Cache + Torbox) avviato su porta ${PORT}!`));
