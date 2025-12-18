require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const { connectDB } = require("./src/db");
const Image = require("./src/models/Image");
const {
  ensureMobilenet,
  embedImageFile,
  cosineSimilarity,
} = require("./src/services/embeddings");

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static("public"));
app.use("/uploads", express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const ts = Date.now();
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${ts}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(
      file.mimetype
    );
    cb(ok ? null : new Error("Unsupported image type"), ok);
  },
});

// Healthcheck
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post(
  "/api/images/upload",
  upload.array("images", 100),
  async (req, res) => {
    try {
      await ensureMobilenet();

      const files = req.files || [];
      if (files.length === 0)
        return res.status(400).json({ error: "No images uploaded" });

      const docs = [];
      for (const f of files) {
        const relPath = path.join(UPLOADS_DIR, path.basename(f.path));
        const url = `/uploads/${path.basename(f.path)}`;

        const embedding = await embedImageFile(f.path);

        const doc = await Image.create({
          path: relPath,
          url,
          label: null,
          embedding,
        });
        docs.push(doc);
      }
      res.json({ uploaded: docs.length, ids: docs.map((d) => d._id) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || "Upload failed" });
    }
  }
);

app.get("/api/images/next-unlabeled", async (req, res) => {
  try {
    const doc = await Image.findOne({ label: null })
      .sort({ createdAt: 1 })
      .lean();
    if (!doc) return res.status(404).json({ message: "No unlabeled images" });
    res.json({
      id: doc._id,
      url: doc.url,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/images/:id/label", async (req, res) => {
  try {
    const id = req.params.id;
    const { isPencil } = req.body;
    if (typeof isPencil !== "boolean")
      return res.status(400).json({ error: "isPencil must be boolean" });

    const label = isPencil ? "pencil" : "not_pencil";
    const updated = await Image.findByIdAndUpdate(id, { label }, { new: true });
    if (!updated) return res.status(404).json({ error: "Image not found" });
    res.json({ ok: true, id: updated._id, label: updated.label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/classify", upload.single("image"), async (req, res) => {
  try {
    await ensureMobilenet();
    const f = req.file;
    if (!f) return res.status(400).json({ error: "No image uploaded" });

    const queryEmbedding = await embedImageFile(f.path);

    const labeled = await Image.find({
      label: { $in: ["pencil", "not_pencil"] },
      embedding: { $exists: true },
    })
      .select({ embedding: 1, label: 1, url: 1 })
      .lean();

    if (labeled.length === 0) {
      return res.status(400).json({
        error: "No labeled data yet. Please label some images first.",
      });
    }

    const k = Math.min(5, labeled.length);
    const scored = labeled
      .map((doc) => {
        const sim = cosineSimilarity(queryEmbedding, doc.embedding);
        return { ...doc, sim };
      })
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

    const sumSim = scored.reduce((s, x) => s + Math.max(0, x.sim), 0) || 1e-6;
    const pencilScore =
      scored
        .filter((x) => x.label === "pencil")
        .reduce((s, x) => s + Math.max(0, x.sim), 0) / sumSim;

    const threshold = 0.5;
    const hasPencil = pencilScore >= threshold;

    res.json({
      hasPencil,
      score: pencilScore,
      k,
      neighbors: scored.map((x) => ({
        url: x.url,
        label: x.label,
        similarity: x.sim,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Classification failed" });
  }
});

(async () => {
  try {
    await connectDB();
    await ensureMobilenet();
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
