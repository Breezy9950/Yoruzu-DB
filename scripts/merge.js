const fs = require('fs');

async function buildMasterDb() {
  console.log("Loading databases...");
  const anibridge = JSON.parse(fs.readFileSync('anibridge.json', 'utf8'));
  const manami = JSON.parse(fs.readFileSync('manami.json', 'utf8'));

  console.log("Extracting Titles and IDs from Manami...");
  const animeData = {};
  for (const anime of manami.data) {
    const sources = anime.sources || [];
    const alSource = sources.find(s => s.includes('anilist.co/anime/'));
    if (!alSource) continue;
    const alId = alSource.split('/anime/')[1];

    const malSource = sources.find(s => s.includes('myanimelist.net/anime/'));
    const malId = malSource ? malSource.split('/anime/')[1] : null;

    const kitSource = sources.find(s => s.includes('kitsu.app/anime/') || s.includes('kitsu.io/anime/'));
    const kitsuId = kitSource ? kitSource.split('/anime/')[1] : null;

    animeData[alId] = {
      titles: [anime.title, ...(anime.synonyms || [])].filter(Boolean),
      malId,
      kitsuId,
      format: anime.type || null,
      status: anime.status || null,
      episodes: anime.episodes || null,
      year: anime.animeSeason && anime.animeSeason.year ? anime.animeSeason.year : null,
      season: anime.animeSeason && anime.animeSeason.season ? anime.animeSeason.season : null
    };
  }

  console.log("Mapping AniBridge episode ranges...");
  const mappings = {};
  let droppedAnilist = 0;
  let skippedMalformed = 0;
  let skippedLengthMismatch = 0;

  for (const [sourceKey, targets] of Object.entries(anibridge)) {
    if (sourceKey.startsWith('$') || !sourceKey.includes(':')) continue;

    const sourceParts = sourceKey.split(':');
    const sourceProvider = sourceParts[0].replace('_show', '').replace('_movie', '');
    const sourceId = sourceParts[1];
    const sourceSeason = sourceParts[2] || 's1';
    const normalizedSourceKey = `${sourceProvider}:${sourceId}:${sourceSeason}`;

    for (const [targetKey, rangeMap] of Object.entries(targets)) {
      if (targetKey.startsWith('$') || !targetKey.includes(':')) continue;

      const targetParts = targetKey.split(':');
      if (targetParts[0] !== 'anilist') continue;

      const anilistId = targetParts[1];
      if (!animeData[anilistId]) { droppedAnilist++; continue; }

      if (!mappings[normalizedSourceKey]) {
        mappings[normalizedSourceKey] = [];
      }

      for (const [srcRange, tgtRange] of Object.entries(rangeMap)) {
        const srcParts = String(srcRange).split('-');
        const tgtParts = String(tgtRange).split('-');

        const srcStart = Number(srcParts[0]);
        const srcEndRaw = srcParts.length > 1 ? Number(srcParts[1]) : srcStart;
        const tgtStart = Number(tgtParts[0]);
        const tgtEndRaw = tgtParts.length > 1 ? Number(tgtParts[1]) : tgtStart;

        if (!Number.isFinite(srcStart) || !Number.isFinite(srcEndRaw) || !Number.isFinite(tgtStart)) {
          skippedMalformed++;
          continue;
        }
        const srcEnd = srcEndRaw;

        const srcLen = srcEnd - srcStart + 1;
        const tgtLen = Number.isFinite(tgtEndRaw) ? (tgtEndRaw - tgtStart + 1) : 1;
        if (srcLen !== tgtLen) {
          skippedLengthMismatch++;
          continue;
        }

        mappings[normalizedSourceKey].push({
          srcStart,
          srcEnd,
          tgtStart,
          anilistId
        });
      }
    }
  }

  for (const key in mappings) {
    mappings[key].sort((a, b) => a.srcStart - b.srcStart);
  }

  const finalDb = { anime: animeData, mappings };

  // --- Validation ---
  const animeCount = Object.keys(animeData).length;
  const mappingCount = Object.keys(mappings).length;

  console.log("\nBuild stats:");
  console.log(`  anime entries: ${animeCount}`);
  console.log(`  mapping keys: ${mappingCount}`);
  console.log(`  dropped AniBridge targets: ${droppedAnilist}`);
  console.log(`  skipped malformed ranges: ${skippedMalformed}`);
  console.log(`  skipped length-mismatch ranges: ${skippedLengthMismatch}`);

  if (animeCount < 15000) throw new Error(`VALIDATION FAILED: anime count too low (${animeCount})`);
  if (mappingCount < 40000) throw new Error(`VALIDATION FAILED: mapping count too low (${mappingCount})`);

  fs.writeFileSync('master-db.json', JSON.stringify(finalDb));
  console.log(`\nMaster DB built successfully! Size: ${(fs.statSync('master-db.json').size / 1024 / 1024).toFixed(2)} MB`);

  // --- DIFFING LOGIC ---
  console.log("\nGenerating incremental updates...");
  let oldDb = { anime: {}, mappings: {} };
  if (fs.existsSync('old-master-db.json')) {
    try {
      oldDb = JSON.parse(fs.readFileSync('old-master-db.json', 'utf8'));
      console.log("Loaded old-master-db.json for comparison.");
    } catch (e) {
      console.log("Could not parse old-master-db.json. Assuming fresh build.");
    }
  } else {
    console.log("No old-master-db.json found. All entries will be marked as new.");
  }

  const updates = { anime: {}, mappings: {} };
  let newAnimeCount = 0;
  let changedAnimeCount = 0;
  let newMappingCount = 0;
  let changedMappingCount = 0;

  // 1. Diff Anime
  for (const [alId, data] of Object.entries(animeData)) {
    const oldData = oldDb.anime[alId];
    if (!oldData) {
      updates.anime[alId] = data;
      newAnimeCount++;
    } else if (JSON.stringify(oldData) !== JSON.stringify(data)) {
      updates.anime[alId] = data;
      changedAnimeCount++;
    }
  }

  // 2. Diff Mappings
  for (const [key, rules] of Object.entries(mappings)) {
    const oldRules = oldDb.mappings[key];
    if (!oldRules) {
      updates.mappings[key] = rules;
      newMappingCount++;
    } else if (JSON.stringify(oldRules) !== JSON.stringify(rules)) {
      updates.mappings[key] = rules;
      changedMappingCount++;
    }
  }

  fs.writeFileSync('updates.json', JSON.stringify(updates));
  
  console.log(`\nUpdates generated! Size: ${(fs.statSync('updates.json').size / 1024).toFixed(2)} KB`);
  console.log(`  New Anime: ${newAnimeCount}, Changed Anime: ${changedAnimeCount}`);
  console.log(`  New Mappings: ${newMappingCount}, Changed Mappings: ${changedMappingCount}`);
}

buildMasterDb().catch(err => {
  console.error(err);
  process.exit(1);
});
