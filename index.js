const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

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

    // Get Public Lessons

    app.get("/lessons", async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find({}) // both public & premium
          .sort({ createdAt: -1 })
          .toArray();

        res.send(lessons);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch lessons" });
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

    // ===== Get lesson by ID (with recommended lessons) =====
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson)
          return res.status(404).send({ message: "Lesson not found" });

        // Fetch recommended lessons (same category or emotionalTone)
        const recommended = await lessonsCollection
          .find({
            _id: { $ne: lesson._id },
            $or: [
              { category: lesson.category },
              { emotionalTone: lesson.emotionalTone },
            ],
            accessLevel: "public", // show only public lessons
          })
          .limit(6)
          .toArray();

        lesson.recommended = recommended;

        res.send(lesson);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch lesson" });
      }
    });

    // ===== Toggle Like =====
    app.patch("/lessons/:id/like", async (req, res) => {
      const lessonId = req.params.id;
      const { userId } = req.body;

      try {
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(lessonId),
        });
        if (!lesson)
          return res.status(404).send({ message: "Lesson not found" });

        const alreadyLiked = lesson.likes?.includes(userId);

        const update = alreadyLiked
          ? { $pull: { likes: userId }, $inc: { likesCount: -1 } }
          : { $addToSet: { likes: userId }, $inc: { likesCount: 1 } };

        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          update
        );

        res.send({ liked: !alreadyLiked });
      } catch (err) {
        res.status(500).send({ message: "Failed to update like" });
      }
    });

    // ===== Add to Favorites =====
    app.post("/favorites", async (req, res) => {
      const { lessonId, userEmail } = req.body;

      try {
        const exists = await favoritesCollection.findOne({
          lessonId,
          userEmail,
        });
        if (exists) return res.send({ message: "Already favorited" });

        await favoritesCollection.insertOne({
          lessonId,
          userEmail,
          createdAt: new Date(),
        });
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: 1 } }
        );

        res.send({ success: true });
      } catch (err) {
        res.status(500).send({ message: "Failed to add favorite" });
      }
    });

    // ===== Remove from Favorites =====
    app.delete("/favorites", async (req, res) => {
      const { lessonId, userEmail } = req.body;

      try {
        const result = await favoritesCollection.deleteOne({
          lessonId,
          userEmail,
        });
        if (result.deletedCount === 1) {
          await lessonsCollection.updateOne(
            { _id: new ObjectId(lessonId) },
            { $inc: { favoritesCount: -1 } }
          );
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to remove favorite" });
      }
    });

    // ===== Report Lesson =====
    app.post("/reports", async (req, res) => {
      const { lessonId, reporterEmail, reason } = req.body;

      try {
        const existing = await reportsCollection.findOne({
          lessonId,
          reporterEmail,
        });
        if (existing)
          return res.status(400).send({ message: "Already reported" });

        await reportsCollection.insertOne({
          lessonId,
          reporterEmail,
          reason,
          createdAt: new Date(),
        });
        res.send({ success: true });
      } catch (err) {
        res.status(500).send({ message: "Failed to report lesson" });
      }
    });

    // ===== Get Comments =====
    app.get("/comments", async (req, res) => {
      const { lessonId } = req.query;

      try {
        const query = lessonId ? { lessonId } : {};
        const comments = await commentsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(comments);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch comments" });
      }
    });

    // ===== Post Comment =====
    app.post("/comments", async (req, res) => {
      const { lessonId, commenterEmail, commenterName, comment } = req.body;

      try {
        const newComment = {
          lessonId,
          commenterEmail,
          commenterName,
          comment,
          createdAt: new Date(),
        };

        await commentsCollection.insertOne(newComment);
        res.send({ success: true });
      } catch (err) {
        res.status(500).send({ message: "Failed to post comment" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
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
