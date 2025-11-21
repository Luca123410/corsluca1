const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI ESTERNI (Assicurati che questi file esistano nella stessa cartella) ---
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");
const TorrentMagnet = require("./torrentmagnet");
const UIndex = require("./uindex"); 

// --- CONFIGURAZIONE CACHE ---
// Stream: 30 min (1800s) | Catalogo: 12 ore (43200s)
const streamCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 });

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifest = {
    id: "org.community.corsaro-visual-update",
    version: "22.0.5", 
    name: "Corsaro + Global (Ultimate)",
    description: "5 Motori - Stile Torrentio - Cache Attiva",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// --- UTILITIES ---
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Filtro per scartare file fake/troppo piccoli (250MB) se RD risponde
const REAL_SIZE_FILTER = 250 * 1024 * 1024; 

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

// Funzione per estrarre info extra (Risoluzione, Audio) dal titolo
function extractStreamInfo(title) {
    const t = title.toLowerCase();
    let quality = "Unknown";
    if (t.includes("2160p") || t.includes("4k")) quality = "4k";
    else if (t.includes("1080p")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    else if (t.includes("dvdrip")) quality = "DVD";

    let lang = [];
    if (t.includes("ita") || t.includes("italian")) lang.push("ITA 🇮🇹");
    if (t.includes("multi") || t.includes("dual")) lang.push("MULTI 🌐");
    if (t.includes("eng") && !t.includes("ita")) lang.push("ENG 🇬🇧");
    
    // Se non trova nulla ma è una fonte italiana nota, forziamo ITA
    return { quality, lang };
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

// --- STREAM HANDLER (CORE) ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, tmdb } = config || {};
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    // 1. CONTROLLO CACHE
    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE: ${id}`);
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante (RD/TMDB)" }] };

    try {
        // 2. OTTENIMENTO METADATA
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

        // 3. RICERCA PENTA (5 MOTORI)
        const [corsaroRes, uindexRes, apiRes, magnetRes] = await Promise.all([
            Corsaro.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            UIndex.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            Apibay.searchMagnet(searchBase, metadata.year).catch(()=>[]),
            TorrentMagnet.searchMagnet(searchBase, metadata.year).catch(()=>[])
        ]);

        let allResults = [...corsaroRes, ...uindexRes, ...apiRes, ...magnetRes];

        // Fallback Titolo Originale
        if (allResults.length === 0 && metadata.title !== metadata.originalTitle) {
            const searchBaseOrig = metadata.isSeries ? 
                `${metadata.originalTitle} S${String(metadata.season).padStart(2, '0')}E${String(metadata.episode).padStart(2, '0')}` : 
                `${metadata.originalTitle} ${metadata.year}`;
            
            const [corsaroOrig, uindexOrig, apiOrig, magnetOrig] = await Promise.all([
                Corsaro.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                UIndex.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                Apibay.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[]),
                TorrentMagnet.searchMagnet(searchBaseOrig, metadata.year).catch(()=>[])
            ]);
            allResults = [...corsaroOrig, ...uindexOrig, ...apiOrig, ...magnetOrig];
        }

        if (allResults.length === 0) return { streams: [{ title: `🚫 Nessun risultato trovato` }] };

        // 4. DEDUPLICAZIONE E ORDINAMENTO
        const uniqueResults = [];
        const magnetSet = new Set();
        for (const item of allResults) {
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            if (!magnetSet.has(key)) {
                magnetSet.add(key);
                uniqueResults.push(item);
            }
        }
        uniqueResults.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
        const topResults = uniqueResults.slice(0, 20); // Analizziamo solo i primi 20

        // 5. VERIFICA SU REAL-DEBRID E FORMATTAZIONE
        let streams = [];
        for (const item of topResults) {
            try {
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                // Saltiamo file troppo piccoli se RD ci conferma la dimensione
                if (streamData && streamData.type === 'ready') {
                    if (streamData.size && streamData.size < REAL_SIZE_FILTER) continue; 
                }

                // --- CREAZIONE VISUALE STILE TORRENTIO ---
                
                // Estrazione Dati Visivi
                const fileTitle = streamData?.filename || item.title;
                const { quality, lang } = extractStreamInfo(fileTitle);
                
                // Determina le lingue (Fallback se non trovate nel titolo)
                let displayLang = lang.join(" / ");
                if (!displayLang) {
                     if (item.source === "Corsaro" || item.source === "UIndex") displayLang = "ITA 🇮🇹";
                     else displayLang = "MULTI / ENG 🌐";
                }

                // NOME (Colonna Sinistra)
                // Es: [RD ⚡] Corsaro
                //     1080p
                let nameTag = `[RD ⚡] ${item.source}`;
                if (!streamData) nameTag = `[RD ⏳] ${item.source}`; // Icona clessidra se non pronto
                nameTag += `\n${quality}`; // Aggiunge risoluzione sotto

                // TITOLO (Colonna Destra - Multilinea)
                let finalSize = streamData?.size ? formatBytes(streamData.size) : (item.size || "?? GB");
                
                // Se il link non è pronto/verificato, puliamo la dimensione fake
                if (!streamData) {
                     if(finalSize.includes("MB") && parseInt(finalSize) < 100) finalSize = "?? GB";
                     if(finalSize.toLowerCase().endsWith("b") && !finalSize.toLowerCase().includes("k")) finalSize = "?? GB";
                }

                let titleStr = `📄 ${fileTitle}\n`;
                titleStr += `💾 ${finalSize}\n`;
                titleStr += `⚙️ ${item.source}\n`;
                titleStr += `🔊 ${displayLang}`;

                if (streamData) {
                    // SUCCESSO RD
                    streams.push({
                        name: nameTag,
                        title: titleStr,
                        url: streamData.url,
                        behaviorHints: { notWebReady: false }
                    });
                } else {
                    // FALLBACK RD (Download o Timeout)
                    streams.push({
                        name: nameTag.replace('⚡', '⚠️'), // Icona Warning
                        title: `${titleStr}\n⚠️ Link Diretto (Download Richiesto)`,
                        url: item.magnet,
                        behaviorHints: { notWebReady: true }
                    });
                }
                
                await wait(50); // Piccola pausa anti-ban
            } catch (e) {
                // Gestione errore singolo link
                streams.push({
                    name: `[RD ❌] ${item.source}`,
                    title: `${item.title}\n⚠️ Errore verifica RD`,
                    url: item.magnet,
                    behaviorHints: { notWebReady: true }
                });
            }
        }

        const finalResponse = streams.length === 0 ? { streams: [{ title: "🚫 Nessun file valido." }] } : { streams };
        
        // SALVATAGGIO CACHE
        streamCache.set(cacheKey, finalResponse);
        
        return finalResponse;

    } catch (error) {
        console.error("🔥 Errore fatale:", error.message);
        return { streams: [{ title: "Errore Interno Addon" }] };
    }
}

// --- ROTTE EXPRESS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifest };
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

// --- START SERVER ---
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon Visual Ultimate v22.0.5 avviato su porta ${PORT}!`));
