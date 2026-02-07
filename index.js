const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(cors());

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
    await client.connect();

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
          photoUrl: user.photoUrl,
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
    app.post("/lessons", async (req, res) => {
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

    app.get("/dashboard/summary", async (req, res) => {
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

        // Weekly analytics (last 7 days)
        // const sevenDaysAgo = new Date();
        // sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

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
          photoUrl: author?.photoUrl || null,
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
                photoURL: "$photoUrl",
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
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
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
