const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 9000;

const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('Running Node version:', process.version);

const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: { version: '1' },
  tls: true
});

const getStartOfTodayUTC = () => {
  const now = new Date();
  const utcNow = new Date(now.toISOString());
  return new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate()));
};

const getStartOfMonthUTC = () => {
  const now = new Date();
  const utcNow = new Date(now.toISOString());
  return new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), 1));
};

const isInstrumentEnabled = (text, instrument) => {
  const blockRegex = new RegExp(`\\(\\s*['"]${instrument}['"][\\s\\S]*?\\(\\s*['"]enabled['"]\\s+(\\d)\\s*\\)`, 'i');
  const match = text.match(blockRegex);
  if (!match) {
    console.warn(`Could not determine enabled status for: ${instrument}`);
    return false;
  }
  return match[1] === '1';
};

const parseRbproj = (text) => {
  const getString = (key) => {
    const regex = new RegExp(`\\(\\s*['"]${key}['"]\\s*\\n?\\s*["']([^"']+)["']\\s*\\)`, 'i');
    const match = text.match(regex);
    if (!match) console.warn(`Couldn't find: ${key}`);
    return match ? match[1] : null;
  };

  const getNumber = (key) => {
    const regex = new RegExp(`\\(\\s*['"]${key}['"]\\s+(\\d+)\\s*\\)`, 'i');
    const match = text.match(regex);
    if (!match) console.warn(`Couldn't find number: ${key}`);
    return match ? parseInt(match[1], 10) : 0;
  };

  const cleanSubGenre = (val) => {
    if (!val || !val.startsWith('subgenre_')) return val;
    const cleaned = val.replace('subgenre_', '');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  };

  const guitarEnabled = isInstrumentEnabled(text, 'guitar');
  const bassEnabled = isInstrumentEnabled(text, 'bass');
  const drumsEnabled = isInstrumentEnabled(text, 'drum_kit');
  const vocalsEnabled = isInstrumentEnabled(text, 'vocals');
  const keysEnabled = isInstrumentEnabled(text, 'keys');

  return {
    title: getString('song_name'),
    artist: getString('artist_name'),
    album: getString('album_name'),
    genre: cleanSubGenre(getString('sub_genre')),
    year: getNumber('year_released'),
    rank_guitar: guitarEnabled ? getNumber('rank_guitar') : 0,
    rank_bass: bassEnabled ? getNumber('rank_bass') : 0,
    rank_drum: drumsEnabled ? getNumber('rank_drum') : 0,
    rank_vocals: vocalsEnabled ? getNumber('rank_vocals') : 0,
    rank_keys: keysEnabled ? getNumber('rank_keys') : 0,
    rank_pro_keys: getNumber('rank_pro_keys'),
    vocal_parts: vocalsEnabled ? getNumber('vocal_parts') : 0
  };
};

async function startServer() {
  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db('songs-database');

    app.get('/api/songs', async (req, res) => {
      try {
        const rawSongs = await db.collection('songs').find({}).toArray();
        const songs = rawSongs.map(song => ({
          ...song,
          _id: song._id.toString()
        }));
        res.json(songs);
      } catch (err) {
        console.error('Error fetching songs:', err);
        res.status(500).json({ error: 'Failed to fetch songs' });
      }
    });

    app.post('/api/increment-downloads', async (req, res) => {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing song ID' });

      try {
        await db.collection('songs').updateOne(
          { _id: new ObjectId(id) },
          { $inc: { downloads: 1 } }
        );

        await db.collection('downloads-log').insertOne({
          songId: new ObjectId(id),
          timestamp: new Date(),
          ip: req.ip
        });

        res.status(200).json({ success: true });
      } catch (err) {
        console.error('Failed to increment downloads:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/stats/summary', async (req, res) => {
      try {
        const songs = await db.collection('songs').find({}).toArray();
        const totalDownloads = songs.reduce((sum, song) => sum + (song.downloads || 0), 0);
        const totalSongs = songs.length;
        const avgDownloads = Math.ceil(totalDownloads / (totalSongs || 1));

        const downloadsLog = db.collection('downloads-log');
        const startOfToday = getStartOfTodayUTC();
        const startOfMonth = getStartOfMonthUTC();

        const todaysDownloads = await downloadsLog.countDocuments({ timestamp: { $gte: startOfToday } });
        const monthlyDownloads = await downloadsLog.countDocuments({ timestamp: { $gte: startOfMonth } });

        res.json({
          totalDownloads,
          totalSongs,
          avgDownloads,
          todaysDownloads,
          monthlyDownloads
        });
      } catch (err) {
        console.error('Failed to fetch summary stats:', err);
        res.status(500).json({ error: 'Failed to fetch summary stats' });
      }
    });

    app.get('/api/stats/top-downloads', async (req, res) => {
      try {
        const songs = await db.collection('songs')
          .find({})
          .sort({ downloads: -1 })
          .limit(10)
          .toArray();
        res.json(songs);
      } catch (err) {
        console.error('Failed to fetch top downloads:', err);
        res.status(500).json({ error: 'Failed to fetch top downloads' });
      }
    });

    app.get('/api/stats/top-by-day', async (req, res) => {
      try {
        const result = await db.collection('downloads-log').aggregate([
          {
            $group: {
              _id: {
                day: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$timestamp",
                    timezone: "Australia/Sydney"
                  }
                },
                songId: "$songId"
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { "_id.day": 1, count: -1 } },
          {
            $group: {
              _id: "$_id.day",
              topSong: { $first: "$_id.songId" },
              downloads: { $first: "$count" }
            }
          },
          {
            $lookup: {
              from: "songs",
              localField: "topSong",
              foreignField: "_id",
              as: "song"
            }
          },
          { $unwind: "$song" },
          { $sort: { _id: -1 } },
          { $limit: 10 }
        ]).toArray();

        res.json(result.map(r => ({
          date: r._id,
          title: r.song.title,
          artist: r.song.artist,
          downloads: r.downloads,
          cover_url: r.song.cover_url
        })));
      } catch (err) {
        console.error('Failed to fetch top by day:', err);
        res.status(500).json({ error: 'Failed to fetch top-by-day stats' });
      }
    });

    app.post('/api/upload-song', upload.single('rbproj'), async (req, res) => {
      try {
        const rbprojText = fs.readFileSync(req.file.path, 'utf-8');
        const metadata = parseRbproj(rbprojText);
		const downloadCount = parseInt(req.body.downloads, 10);
			if (isNaN(downloadCount) || downloadCount < 0) {
			  return res.status(400).json({ error: 'Invalid download count' });
			}


        const song = {
          ...metadata,
          length: req.body.length,
          cover_url: req.body.cover_url,
          drive_urls: Array.isArray(req.body.drive_urls)
	  ? req.body.drive_urls
	  : req.body.drive_urls
	    ? [req.body.drive_urls]
	    : [],
          preview_url: req.body.preview_url,
          notes: req.body.notes,
          rating: req.body.rating,
          downloads: parseInt(req.body.downloads, 10),
          dateUpdated: new Date()
        };

        await db.collection('songs').insertOne(song);
        fs.unlinkSync(req.file.path);

        res.status(201).json({ success: true });
      } catch (err) {
        console.error('Upload failed:', err);
        res.status(500).json({ error: 'Upload failed' });
      }
    });

    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'public/index.html'));
    });

    app.listen(port, () => {
      console.log(`Server is running at http://localhost:${port}`);
    });

  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }
}

startServer();
setInterval(() => {
  fetch('https://dingorb.com/')
    .then(res => console.log(`Keep-alive ping: ${res.status}`))
    .catch(err => console.error('Keep-alive ping failed:', err));
}, 1000 * 60 * 14); // every 14 minutes
