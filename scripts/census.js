/* global db, print */
// Read-only database census for diffing before/after a deploy. Only runs
// find/aggregate/countDocuments/getCollectionNames; never writes. Prints one
// JSON document (no values, no personal data: ids are Mongo _ids only).
//
//   docker compose -f compose.prod.yaml exec -T mongoserver \
//     mongosh --quiet SalesBotDB --eval "$(cat scripts/census.js)"

const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const ids = (docs) => docs.map((d) => String(d._id));

// Sorted ["field:bsonType", ...] for each document, via $type.
const shapeStages = [{ $project: { s: { $sortArray: { sortBy: 1, input: {
  $map: { input: { $objectToArray: "$$ROOT" }, as: "f", in: { $concat: ["$$f.k", ":", { $type: "$$f.v" }] } },
} } } } }];
const shapes = (coll) => sorted(Object.fromEntries(
  db[coll].aggregate([...shapeStages, { $group: { _id: "$s", n: { $sum: 1 } } }])
    .toArray().map((d) => [d._id.join(","), d.n])));
const hist = (coll, field) => sorted(Object.fromEntries(
  db[coll].aggregate([{ $group: { _id: { $ifNull: ["$" + field, "null"] }, n: { $sum: 1 } } }])
    .toArray().map((d) => [String(d._id), d.n])));
// Field -> type of the newest document matching filter. No values.
const sample = (coll, filter) => {
  const d = db[coll].aggregate([{ $match: filter }, { $sort: { _id: -1 } }, { $limit: 1 }, ...shapeStages]).toArray()[0];
  return d ? sorted(Object.fromEntries(d.s.map((f) => f.split(/:(?=[^:]*$)/)))) : null;
};
const idList = (coll, filter) => {
  const d = db[coll].find(filter, { _id: 1 }).sort({ _id: 1 }).toArray();
  return { count: d.length, ids: ids(d) };
};

const byStatus = hist("posts", "status");
const byAuthLevel = hist("users", "authLevel");

const media = { totalItems: 0, postsWithZeroMedia: 0, byType: {}, orphanedMedia: { count: 0, postIds: [] } };
db.posts.find({}, { media: 1 }).sort({ _id: 1 }).forEach((p) => {
  const m = Array.isArray(p.media) ? p.media : [];
  let bad = false;
  media.totalItems += m.length;
  if (!m.length) media.postsWithZeroMedia++;
  m.forEach((i) => {
    const t = String(i && i.type);
    media.byType[t] = (media.byType[t] || 0) + 1;
    if (!i || !i.fileId || (i.type !== "photo" && i.type !== "video")) { media.orphanedMedia.count++; bad = true; }
  });
  if (bad) media.orphanedMedia.postIds.push(String(p._id));
});
media.byType = sorted(media.byType);

const orphans = db.posts.aggregate([
  { $lookup: { from: "users", localField: "userId", foreignField: "userId", as: "u" } },
  { $match: { u: { $size: 0 } } }, { $project: { _id: 1 } }, { $sort: { _id: 1 } },
]).toArray();

const result = {
  generatedAt: new Date().toISOString(),
  collections: sorted(Object.fromEntries(db.getCollectionNames().map((n) => [n, db.getCollection(n).countDocuments({})]))),
  posts: {
    byStatus,
    nullMessageIds: {
      approvedWithoutApprovedMessageId: idList("posts", { status: "approved", approvedMessageId: null }),
      // Expected: syncSoldPosts/markSoldInGroup clear the id when the group message is gone.
      soldWithoutApprovedMessageId: idList("posts", { status: "sold", approvedMessageId: null }),
      pendingWithoutModerationMessageId: idList("posts", { status: "pending", moderationMessageId: null }),
    },
    orphaned: { count: orphans.length, ids: ids(orphans) },
    media,
    shapes: shapes("posts"),
  },
  users: {
    byAuthLevel,
    byLanguageCode: hist("users", "languageCode"),
    byPreferredLocale: hist("users", "preferredLocale"),
    shapes: shapes("users"),
  },
  samples: {
    posts: sorted(Object.fromEntries(Object.keys(byStatus).map((s) =>
      [s, sample("posts", s === "null" ? { status: null } : { status: s })]))),
    users: sorted(Object.fromEntries(Object.keys(byAuthLevel).map((l) =>
      [l, sample("users", l === "null" ? { authLevel: null } : { authLevel: Number(l) })]))),
  },
};

print(JSON.stringify(result, null, 2));
