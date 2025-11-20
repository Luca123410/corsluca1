const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio"); // NECESSARIO PER LO SCRAPING

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- DOMINIO CORSARO (Aggiornabile se cambia) ---
const CORSARO_URL = "https://ilcorsaronero.link"; 

const manifest = {
    id: "org.community.corsaro-rd",
    version: "1.0.2",
    name: "Corsaro Nero & Real-Debrid",
    description: "Ricerca contenuti ITA e sblocca con Real-Debrid",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "tmdb_trending", name: "Film Popolari (TMDB)" }
    ],
    idPrefixes: ["tmdb"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } 
    catch (e) { return {}; }
}

// --- FUNZIONE DI SCRAPING (Basata su Riklus) ---
async function getCorsaroMagnet(query) {
    try {
        // Costruiamo l'URL di ricerca
        const searchUrl = `${CORSARO_URL}/argh.php?search=${encodeURIComponent(query)}`;
        console.log(`🔎 Cerco su Corsaro: ${query} -> ${searchUrl}`);

        const { data } = await axios.get(searchUrl);
        const $ = cheerio.load(data);
        
        let magnet = null;
        let foundTitle = "";

        // Cerchiamo nella tabella dei risultati
        // Il selettore cerca i link che contengono 'magnet:?'
        $('a[href^="magnet:?"]').each((i, elem) => {
            if (magnet) return; // Prendiamo solo il primo risultato per ora
            
            const link = $(elem).attr('href');
            const title = $(elem).closest('tr').find('.tab').text().trim(); // Titolo nella tabella

            // Filtro base: evitiamo risultati spazzatura se necessario
            if (link) {
                magnet = link;
                foundTitle = title;
            }
        });

        if (magnet) {
            console.log(`✅ Trovato: ${foundTitle}`);
            return magnet;
        } else {
            console.log("❌ Nessun magnet trovato.");
            return null;
        }

    } catch (error) {
        console.error("Errore scraping Corsaro:", error.message);
        return null;
    }
}

// --- CATALOG HANDLER (TMDB) ---
builder.defineCatalogHandler(async ({ type, id, config }) => {
    const tmdbKey = config?.tmdb;
    if (!tmdbKey) return { metas: [{ id: 'err', type: 'movie', name: 'Manca TMDB Key' }] };

    if (type === "movie" && id === "tmdb_trending") {
        const url = `https://api.themoviedb.org/3/trending/movie/day?api_key=${tmdbKey}&language=it-IT`;
        const resp = await axios.get(url);
        const metas = resp.data.results.map(m => ({
            id: `tmdb:${m.id}`, type: "movie", name: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`
        }));
        return { metas };
    }
    return { metas: [] };
});

// --- STREAM HANDLER (LOGICA PRINCIPALE) ---
builder.defineStreamHandler(async ({ type, id, config }) => {
    const rdKey = config?.rd;
    const tmdbKey = config?.tmdb;

    if (!rdKey || !tmdbKey) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    const tmdbId = id.split(":")[1];

    try {
        // 1. Ottieni info da TMDB (Titolo e Anno)
        const metaUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}&language=it-IT`;
        const meta = await axios.get(metaUrl);
        
        const title = meta.data.title;
        const year = meta.data.release_date ? meta.data.release_date.split('-')[0] : '';
        
        // Creiamo la query di ricerca (es. "Inception 2010")
        const searchQuery = `${title} ${year}`;

        // 2. Cerca MAGNET su Corsaro Nero
        const magnetLink = await getCorsaroMagnet(searchQuery);

        if (!magnetLink) {
            return { streams: [{ title: "🚫 Nessun torrent ITA trovato" }] };
        }

        // 3. Invia Magnet a Real-Debrid
        const rdAdd = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", 
            `magnet=${encodeURIComponent(magnetLink)}`, { headers: { Authorization: `Bearer ${rdKey}` } });
        
        const torrentId = rdAdd.data.id;

        // 4. Seleziona i file
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
            "files=all", { headers: { Authorization: `Bearer ${rdKey}` } });

        // 5. Ottieni il link
        const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { Authorization: `Bearer ${rdKey}` } });

        if (info.data.links.length === 0) return { streams: [{ title: "RD: In attesa di conversione..." }] };

        // 6. Sblocca il link (Unrestrict)
        const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link", 
            `link=${info.data.links[0]}`, { headers: { Authorization: `Bearer ${rdKey}` } });

        return {
            streams: [{
                title: `🏴‍☠️ Corsaro | RD Stream \n${info.data.filename}`,
                url: unrestrict.data.download
            }]
        };

    } catch (error) {
        console.error("Errore Stream:", error.message);
        return { streams: [{ title: "Errore Tecnico Addon" }] };
    }
});

// --- SERVER ---
const addonInterface = builder.getInterface();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const newManifest = { ...manifest };
    if (config.tmdb && config.rd) newManifest.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(newManifest);
});
app.use('/:userConf', (req, res) => {
    const config = getConfig(req.params.userConf);
    addonInterface(req, res, () => res.status(404).send(), { config });
});

app.listen(process.env.PORT || 7000, () => console.log("Addon Ready!"));
