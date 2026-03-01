const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

// const serviceAccount = require("./digital-life-lessions-firebase-adminsdk.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://digital-life-lesson-beta.vercel.app",
      "https://digital-life-lessions.web.app",
    ],
    credentials: true,
  }),
);

// const verifyFirebaseToken = async (req, res, next) => {
//   const token = req.headers.authorization;

//   if (!token) {
//     return res.status(401).send({ message: "Unauthorized access" });
//   }

//   try {
//     const idToken = token.split(" ")[1];
//     const decoded = await admin.auth().verifyIdToken(idToken);
//     req.decoded_email = decoded.email;
//   } catch (error) {
//     return res.status(401).send({ message: "Unauthorized access" });
//   }

//   next();
// };

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  try {
    const idToken = authHeader.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    req.user = {
      email: decodedToken.email,
      uid: decodedToken.uid,
    };

    next();
  } catch (error) {
    console.error("Token verify error:", error.message);
    return res.status(401).send({
      message: "Token expired or invalid",
    });
  }
};

const verifyAdmin = async (req, res, next) => {
  const email = req.user?.email;

  if (!email) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  const user = await userCollection.findOne({ email });

  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden: Admin only" });
  }

  next();
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uji33wc.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db("digital_life_lessons");
    const userCollection = db.collection("users");
    const lessonsCollection = db.collection("lessons");
    const commentsCollection = db.collection("comments");
    const reportsCollection = db.collection("reports");
    const favoritesCollection = db.collection("favorites");

    // user api
    app.get("/users", async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.email = email;
      }

      const result = await userCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/users/:email/status", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });

      res.send({
        isPremium: user?.isPremium || false,
        role: user?.role || "user",
      });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.createdAt = new Date();
      user.isPremium = false;
      user.role = "user";

      //check user already exit or not
      const email = user.email;
      const userExits = await userCollection.findOne({ email });

      if (userExits) {
        return res.send({ message: "User already exits" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch("/users", async (req, res) => {
      const email = req.query.email;

      const { displayName, photoURL } = req.body;

      const query = { email };

      const updatedDoc = {
        $set: {
          displayName,
          photoURL,
        },
      };

      const result = await userCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    app.get("/users/creator/:email", async (req, res) => {
      const email = req.params.email;

      try {
        const user = await userCollection.findOne({ email });
        if (!user) return res.status(404).send({});

        const totalLessons = await lessonsCollection.countDocuments({
          createdBy: email,
        });

        res.send({
          displayName: user.displayName,
          photoURL: user.photoURL,
          email: user.email,
          totalLessons,
        });
      } catch (err) {
        res.status(500).send({ message: "Failed to load creator" });
      }
    });

    // Get Public Lessons

    app.get("/lessons", async (req, res) => {
      try {
        const { category, emotionalTone, privacy, featured, limit } = req.query;
        const query = {};

        if (!req.user) {
          query.privacy = "public";
        }

        if (category && category !== "all") {
          query.category = category;
        }

        if (emotionalTone && emotionalTone !== "all") {
          query.emotionalTone = emotionalTone;
        }

        if (privacy && privacy !== "all") {
          query.privacy = privacy;
        }

        if (featured === "true") {
          query.isFeatured = true;
        }

        const lessons = await lessonsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .limit(Number(limit) || 50)
          .toArray();

        res.send(lessons);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch lessons" });
      }
    });

    // Add this route for featured lessons specifically
    app.get("/lessons/featured", async (req, res) => {
      try {
        const featuredLessons = await lessonsCollection
          .find({
            privacy: "public",
            isFeatured: true,
            accessLevel: "free",
          })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        res.send(featuredLessons);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch featured lessons" });
      }
    });

    //Post API Create Lessons.
    app.post("/lessons", verifyFirebaseToken, async (req, res) => {
      const lesson = req.body;
      lesson.createdAt = new Date();
      lesson.likes = [];
      lesson.likesCount = 0;
      lesson.favoritesCount = 0;

      const result = await lessonsCollection.insertOne(lesson);
      res.send(result);
    });

    app.get("/lessons/most-saved", async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find({ privacy: "public" })
          .sort({ favoritesCount: -1 })
          .limit(3)
          .toArray();

        res.send(lessons);
      } catch (error) {
        console.error("❌ Most saved lessons error:", error);
        res.status(500).send({ message: "Failed to load most saved lessons" });
      }
    });

    app.get("/dashboard/summary", verifyFirebaseToken, async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({ message: "Email required" });
        }

        // Total lessons created
        const totalLessons = await lessonsCollection.countDocuments({
          createdBy: email,
        });

        // Total favorites saved by user
        const totalFavorites = await favoritesCollection.countDocuments({
          email: email,
        });

        // Recent lessons (last 3)
        const recentLessons = await lessonsCollection
          .find({ createdBy: email })
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();

        const weeklyLessons = await lessonsCollection.countDocuments({
          createdBy: email,
          // createdAt: { $gte: sevenDaysAgo },
        });

        res.send({
          totalLessons,
          totalFavorites,
          recentLessons,
          analytics: {
            weeklyLessons,
          },
        });
      } catch (error) {
        console.error("Dashboard summary error:", error);
        res.status(500).send({ message: "Failed to load dashboard" });
      }
    });

    app.get("/dashboard/analytics/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const data = await lessonsCollection
          .aggregate([
            { $match: { createdBy: email } },
            {
              $group: {
                _id: {
                  week: { $week: "$createdAt" },
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { "_id.week": 1 } },
          ])
          .toArray();

        res.send(data);
      } catch (error) {
        console.error("Analytics error:", error);
        res.status(500).send({ message: "Analytics failed" });
      }
    });
    // GET /lessons/my?email=user@email.com
    app.get("/lessons/my", async (req, res) => {
      try {
        const email = req.query.email;

        console.log("MY LESSONS EMAIL:", email);

        if (!email) {
          return res.status(400).send({ message: "Email query missing" });
        }

        const lessons = await lessonsCollection
          .find({
            createdBy: email,
          })
          .toArray();

        res.send(lessons);
      } catch (error) {
        console.error("LESSONS/MY ERROR:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get lesson by ID (with recommended lessons)
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!lesson) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        // 👉 Fetch author info
        const author = await userCollection.findOne({
          email: lesson.createdBy,
        });

        // 👉 Count total lessons by this author
        const totalLessons = await lessonsCollection.countDocuments({
          createdBy: lesson.createdBy,
          privacy: "public",
        });

        // 👉 Attach author object
        lesson.author = {
          displayName: author?.displayName || "Anonymous",
          photoURL: author?.photoURL || null,
          email: author?.email,
          totalLessons,
        };

        // 👉 Recommended lessons
        const recommended = await lessonsCollection
          .find({
            _id: { $ne: lesson._id },
            privacy: "public",
            $or: [
              { category: lesson.category },
              { emotionalTone: lesson.emotionalTone },
            ],
          })
          .limit(6)
          .toArray();

        lesson.recommended = recommended;

        res.send(lesson);
      } catch (error) {
        console.error("Lesson details error:", error);
        res.status(500).send({ message: "Failed to fetch lesson" });
      }
    });

    // GET lesson by ID (for update)
    app.get("/lessons/edit/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;

        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!lesson) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        res.send(lesson);
      } catch (error) {
        console.error("GET EDIT LESSON ERROR:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // UPDATE lesson
    app.patch("/lessons/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;
        const updatedData = req.body;

        delete updatedData.createdBy; // security
        delete updatedData.createdAt;

        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              ...updatedData,
              updatedAt: new Date(),
            },
          },
        );

        res.send(result);
      } catch (error) {
        console.error("UPDATE LESSON ERROR:", error);
        res.status(500).send({ message: "Failed to update lesson" });
      }
    });

    app.patch("/lessons/:id/like", async (req, res) => {
      const { email } = req.body;
      const lessonId = req.params.id;

      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });

      if (!lesson) {
        return res.status(404).send({ message: "Lesson not found" });
      }

      const alreadyLiked = lesson.likes.includes(email);

      const update = alreadyLiked
        ? {
            $pull: { likes: email },
            $inc: { likesCount: -1 },
          }
        : {
            $addToSet: { likes: email },
            $inc: { likesCount: 1 },
          };

      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        update,
      );

      res.send({ liked: !alreadyLiked });
    });

    app.post("/favorites/toggle", async (req, res) => {
      const { lessonId, email } = req.body;

      const exists = await favoritesCollection.findOne({ lessonId, email });

      if (exists) {
        await favoritesCollection.deleteOne({ lessonId, email });
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: -1 } },
        );
        return res.send({ favorited: false });
      }

      await favoritesCollection.insertOne({
        lessonId,
        email,
        createdAt: new Date(),
      });

      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $inc: { favoritesCount: 1 } },
      );

      res.send({ favorited: true });
    });

    app.post("/reports", async (req, res) => {
      try {
        const { lessonId, reporterEmail, reason } = req.body;

        // basic validation
        if (!lessonId || !reporterEmail || !reason) {
          return res.status(400).send({
            success: false,
            message: "Missing required fields",
          });
        }

        const existingReport = await reportsCollection.findOne({
          lessonId,
          reporterEmail,
        });

        if (existingReport) {
          return res.status(400).send({
            success: false,
            message: "You already reported this lesson.",
          });
        }

        const report = {
          lessonId,
          reporterEmail,
          reason,
          createdAt: new Date(),
        };

        await reportsCollection.insertOne(report);

        res.send({ success: true });
      } catch (error) {
        console.error("REPORT ERROR:", error);
        res.status(500).send({
          success: false,
          message: "Failed to report lesson",
        });
      }
    });
    // ======= My lessons =========

    // PATCH /lessons/:id/visibility
    app.patch("/lessons/:id/visibility", async (req, res) => {
      const { id } = req.params;
      const { privacy } = req.body;

      await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { privacy } },
      );

      res.send({ success: true });
    });

    // PATCH /lessons/:id/access
    app.patch("/lessons/:id/access", async (req, res) => {
      const { id } = req.params;
      const { accessLevel } = req.body;

      await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { accessLevel } },
      );

      res.send({ success: true });
    });

    // DELETE /lessons/:id
    app.delete(
      "/lessons/:id",
      verifyFirebaseToken,
      verifyFirebaseToken,
      async (req, res) => {
        const id = req.params.id;

        await lessonsCollection.deleteOne({ _id: new ObjectId(id) });

        res.send({ success: true });
      },
    );

    // ===============

    // GET /favorites/my?email=user@email.com
    app.get("/favorites/my", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) {
          return res.status(400).send({ message: "Email required" });
        }

        const favorites = await favoritesCollection.find({ email }).toArray();

        if (favorites.length === 0) {
          return res.send([]);
        }

        const lessonIds = favorites.map((fav) => new ObjectId(fav.lessonId));

        const lessons = await lessonsCollection
          .find({ _id: { $in: lessonIds } })
          .toArray();

        const result = lessons.map((lesson) => {
          const fav = favorites.find(
            (f) => f.lessonId === lesson._id.toString(),
          );

          return {
            _id: lesson._id,
            lessonTitle: lesson.lessonTitle,
            category: lesson.category,
            emotionalTone: lesson.emotionalTone,
            likesCount: lesson.likesCount || 0,
            favoritesCount: lesson.favoritesCount || 0,
            createdAt: fav?.createdAt,
          };
        });

        res.send(result);
      } catch (error) {
        console.error("MY FAVORITES ERROR:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // DELETE /favorites/:lessonId
    app.delete("/favorites/remove", verifyFirebaseToken, async (req, res) => {
      try {
        const { lessonId, email } = req.query;

        if (!lessonId || !email) {
          return res.status(400).send({ message: "Missing data" });
        }

        const result = await favoritesCollection.deleteOne({
          lessonId,
          email,
        });

        res.send({
          success: true,
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error("REMOVE FAVORITE ERROR:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // ===== Get Top Contributors =====
    app.get("/users/top-contributors", async (req, res) => {
      try {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        const contributors = await userCollection
          .aggregate([
            {
              $lookup: {
                from: "lessons",
                localField: "email",
                foreignField: "createdBy",
                as: "lessons",
              },
            },
            {
              $addFields: {
                lessons: {
                  $filter: {
                    input: "$lessons",
                    as: "lesson",
                    cond: {
                      $and: [
                        { $eq: ["$$lesson.privacy", "public"] },
                        // { $gte: ["$$lesson.createdAt", oneWeekAgo] },
                      ],
                    },
                  },
                },
              },
            },
            {
              $addFields: {
                totalLessons: { $size: "$lessons" },
              },
            },
            {
              $match: {
                totalLessons: { $gt: 0 },
              },
            },
            {
              $sort: { totalLessons: -1 },
            },
            {
              $limit: 3,
            },
            {
              $project: {
                _id: 1,
                name: "$displayName",
                email: 1,
                photoURL: "$photoURL",
                totalLessons: 1,
              },
            },
          ])
          .toArray();

        res.send(contributors);
      } catch (error) {
        console.error("Top contributors error:", error);
        res.status(500).send({ message: "Failed to load contributors" });
      }
    });

    app.post("/comments", async (req, res) => {
      try {
        const { lessonId, userEmail, userName, userPhoto, comment } = req.body;

        if (!lessonId || !userEmail || !comment) {
          return res.status(400).send({ message: "Missing data" });
        }

        const newComment = {
          lessonId,
          userEmail,
          userName,
          userPhoto,
          comment,
          createdAt: new Date(),
        };

        await commentsCollection.insertOne(newComment);
        res.send({ success: true });
      } catch (error) {
        res.status(500).send({ message: "Failed to add comment" });
      }
    });

    app.get("/comments/:lessonId", async (req, res) => {
      try {
        const comments = await commentsCollection
          .find({ lessonId: req.params.lessonId })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(comments);
      } catch (error) {
        res.status(500).send({ message: "Failed to load comments" });
      }
    });

    // Similar / Recommended lessons
    app.get("/lessons/:id/recommended", async (req, res) => {
      const id = req.params.id;

      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!lesson) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        const recommended = await lessonsCollection
          .find({
            _id: { $ne: lesson._id },
            privacy: "public",
            $or: [
              { category: lesson.category },
              { emotionalTone: lesson.emotionalTone },
            ],
          })
          .limit(6)
          .toArray();

        res.send(recommended);
      } catch (error) {
        console.error("Recommended lessons error:", error);
        res.status(500).send({ message: "Failed to load recommended lessons" });
      }
    });

    // ======= Admin Related APIs ======= //
    app.get(
      "/admin/overview",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const totalUsers = await userCollection.countDocuments();

          const totalPublicLessons = await lessonsCollection.countDocuments({
            privacy: "public",
          });

          const totalReportedLessons = await reportsCollection.countDocuments();

          // Today's lessons
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const todaysLessons = await lessonsCollection.countDocuments({
            createdAt: { $gte: today },
          });

          res.send({
            totalUsers,
            totalPublicLessons,
            totalReportedLessons,
            todaysLessons,
          });
        } catch (err) {
          res.status(500).send({ message: "Admin overview failed" });
        }
      },
    );

    app.get(
      "/admin/analytics",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // ===== USERS GROWTH =====
          const usersGrowth = await userCollection
            .aggregate([
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$createdAt",
                    },
                  },
                  users: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          // ===== LESSONS GROWTH =====
          const lessonsGrowth = await lessonsCollection
            .aggregate([
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$createdAt",
                    },
                  },
                  lessons: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          // ===== MERGE BOTH DATA =====
          const growthMap = {};

          usersGrowth.forEach((item) => {
            growthMap[item._id] = {
              date: item._id,
              users: item.users,
              lessons: 0,
            };
          });

          lessonsGrowth.forEach((item) => {
            if (!growthMap[item._id]) {
              growthMap[item._id] = {
                date: item._id,
                users: 0,
                lessons: item.lessons,
              };
            } else {
              growthMap[item._id].lessons = item.lessons;
            }
          });

          const result = Object.values(growthMap).sort(
            (a, b) => new Date(a.date) - new Date(b.date),
          );

          res.send(result);
        } catch (error) {
          console.error("Admin growth analytics error:", error);
          res.status(500).send({ message: "Failed to load growth analytics" });
        }
      },
    );

    // GET /admin/users
    app.get(
      "/admin/users",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const users = await userCollection
            .aggregate([
              {
                $lookup: {
                  from: "lessons",
                  localField: "email",
                  foreignField: "createdBy",
                  as: "lessons",
                },
              },
              {
                $addFields: {
                  totalLessons: { $size: "$lessons" },
                },
              },
              {
                $project: {
                  displayName: 1,
                  email: 1,
                  role: 1,
                  isPremium: 1,
                  totalLessons: 1,
                },
              },
            ])
            .toArray();

          res.send(users);
        } catch (error) {
          res.status(500).send({ message: "Failed to load users" });
        }
      },
    );

    // PATCH /admin/users/role
    app.patch("/admin/users/role", async (req, res) => {
      const { email, role } = req.body;

      const result = await userCollection.updateOne(
        { email },
        { $set: { role } },
      );

      res.send(result);
    });

    // DELETE /admin/users/:email
    app.delete("/admin/users/:email", async (req, res) => {
      const email = req.params.email;

      await userCollection.deleteOne({ email });
      await lessonsCollection.deleteMany({ createdBy: email });

      res.send({ success: true });
    });

    // GET /admin/lessons
    app.get(
      "/admin/lessons",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const { category, privacy, flagged } = req.query;

        const query = {};
        if (category) query.category = category;
        if (privacy) query.privacy = privacy;

        const lessons = await lessonsCollection.find(query).toArray();

        const lessonIds = lessons.map((l) => l._id.toString());

        const reports = await reportsCollection
          .find({ lessonId: { $in: lessonIds } })
          .toArray();

        const lessonsWithMeta = lessons.map((lesson) => {
          const lessonReports = reports.filter(
            (r) => r.lessonId === lesson._id.toString(),
          );

          return {
            ...lesson,
            reportsCount: lessonReports.length,
            reviewed: lessonReports.length === 0,
          };
        });

        const filtered =
          flagged === "flagged"
            ? lessonsWithMeta.filter((l) => l.reportsCount > 0)
            : lessonsWithMeta;

        res.send(filtered);
      },
    );

    app.get("/admin/lessons/stats", async (req, res) => {
      const total = await lessonsCollection.countDocuments();
      const publicLessons = await lessonsCollection.countDocuments({
        privacy: "public",
      });
      const privateLessons = await lessonsCollection.countDocuments({
        privacy: "private",
      });
      const flagged = await lessonsCollection.countDocuments({
        isReported: true,
      });

      res.send({
        total,
        publicLessons,
        privateLessons,
        flagged,
      });
    });

    app.delete(
      "/admin/lessons/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;

        await lessonsCollection.deleteOne({ _id: new ObjectId(id) });

        res.send({ success: true });
      },
    );

    app.patch("/admin/lessons/:id/featured", async (req, res) => {
      const { id } = req.params;
      const { featured } = req.body;

      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { featured } },
      );

      res.send(result);
    });

    app.patch("/admin/lessons/:id/reviewed", async (req, res) => {
      const lessonId = req.params.id;

      const result = await reportsCollection.deleteMany({ lessonId });

      res.send({
        modifiedCount: result.deletedCount,
      });
    });

    // GET all reported lessons with report details
    app.get(
      "/admin/reported-lessons",
      verifyFirebaseToken,
      verifyAdmin,

      async (req, res) => {
        try {
          const reports = await reportsCollection.find().toArray();

          // group reports by lessonId
          const reportMap = {};
          reports.forEach((r) => {
            if (!reportMap[r.lessonId]) {
              reportMap[r.lessonId] = [];
            }
            reportMap[r.lessonId].push(r);
          });

          const lessonIds = Object.keys(reportMap).map(
            (id) => new ObjectId(id),
          );

          const lessons = await lessonsCollection
            .find({ _id: { $in: lessonIds } })
            .toArray();

          const reportedLessons = lessons.map((lesson) => ({
            ...lesson,
            reportCount: reportMap[lesson._id.toString()].length,
            reports: reportMap[lesson._id.toString()],
          }));

          res.send(reportedLessons);
        } catch (err) {
          res.status(500).send({ message: "Failed to load reported lessons" });
        }
      },
    );

    // Ignore reports (admin reviewed)
    app.patch("/admin/reported-lessons/ignore/:lessonId", async (req, res) => {
      const lessonId = req.params.lessonId;

      await reportsCollection.deleteMany({ lessonId });

      res.send({ success: true });
    });

    app.delete(
      "/admin/reported-lessons/:lessonId",
      verifyFirebaseToken,
      async (req, res) => {
        const lessonId = req.params.lessonId;

        await lessonsCollection.deleteOne({
          _id: new ObjectId(lessonId),
        });

        await reportsCollection.deleteMany({ lessonId });

        res.send({ success: true });
      },
    );

    // ===== ===== Payments Related Api ===== =====//

    app.post("/create-checkout-session", async (req, res) => {
      const userInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: "Premium Membership",
                description: "Unlock premium lessons",
              },
              unit_amount: 150000, // 1500 taka
            },
            quantity: 1,
          },
        ],
        customer_email: userInfo.email,
        mode: "payment",
        metadata: {
          userId: userInfo._id,
          email: userInfo.email,
        },

        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancel`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      //Check payment exits or not
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await userCollection.findOne(query);
      if (paymentExist) {
        return res.send({
          message: "Already Exists",
          transactionId,
        });
      }

      if (session.payment_status === "paid") {
        const userId = session.metadata.userId;
        const query = { _id: new ObjectId(userId) };

        const update = {
          $set: {
            isPremium: true,
            transactionId: session.payment_intent,
          },
        };
        const result = await userCollection.updateOne(query, update);
        res.send(result);
      }
      res.send({ success: true });
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
