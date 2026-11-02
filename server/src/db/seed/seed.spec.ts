process.env.NODE_ENV ??= 'test';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  QueryTypes,
  type Model,
  type ModelStatic,
  type Sequelize,
} from 'sequelize';
import { createCreditedBook } from '../../models/creditedBook.testkit.ts';
import { initModels } from '../../models/index.ts';
import { Book } from '../../models/Book.ts';
import { BookAuthor } from '../../models/BookAuthor.ts';
import { Chapter, countWords } from '../../models/Chapter.ts';
import { Comment } from '../../models/Comment.ts';
import { Favorite } from '../../models/Favorite.ts';
import { Genre } from '../../models/Genre.ts';
import { Illustration } from '../../models/Illustration.ts';
import { LibraryEntry } from '../../models/LibraryEntry.ts';
import { Like } from '../../models/Like.ts';
import { Notification } from '../../models/Notification.ts';
import { Report } from '../../models/Report.ts';
import { ReadingList } from '../../models/ReadingList.ts';
import { ReadingListItem } from '../../models/ReadingListItem.ts';
import { Series } from '../../models/Series.ts';
import { SeriesAuthor } from '../../models/SeriesAuthor.ts';
import { User } from '../../models/User.ts';
import { ensureDatabase } from '../ensureDatabase.ts';
import { skipWithoutMysql } from '../mysqlProbe.testkit.ts';
import { testDbConfig, testDbName } from '../testDb.testkit.ts';
import { createSequelize } from '../sequelize.ts';
import { buildPlan } from './plan.ts';
import { RNG_SEED, createRng } from './rng.ts';

// seed.ts is a script with a top-level `await main()`, so it cannot be imported
// without seeding. These tests run it the way `npm run seed` does, as a child
// process, and watch what it does to a schema of their own.
const TEST_DB_NAME = testDbName('seed');

const SERVER_DIR = path.resolve(import.meta.dirname, '../../..');

// The tables the seed deletes from under --force. Listed again here
// because a script exports nothing a spec could import.
const CONTENT_MODELS: readonly ModelStatic<Model>[] = [
  Notification,
  ReadingListItem,
  ReadingList,
  Favorite,
  LibraryEntry,
  Like,
  Report,
  Comment,
  Illustration,
  Chapter,
  BookAuthor,
  Book,
  SeriesAuthor,
  Series,
  Genre,
  User,
];

interface SeedRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSeed(
  env: NodeJS.ProcessEnv,
  args: readonly string[] = []
): Promise<SeedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--env-file-if-exists=.env.local', 'src/db/seed/seed.ts', ...args],
      { cwd: SERVER_DIR, env }
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    // Stripped of colour codes: under a terminal, node:test hands its children
    // FORCE_COLOR, the seed inherits it, and console.info colours the counts
    // it prints (`users: \x1b[33m1\x1b[39m`), which no pattern below matches.
    child.on('close', (code) => {
      resolve({
        code,
        stdout: stripVTControlCharacters(stdout.join('')),
        stderr: stripVTControlCharacters(stderr.join('')),
      });
    });
  });
}

// Force: a schema left by a red run must not leak its rows into this one.
async function buildSchema(sequelize: Sequelize): Promise<void> {
  await sequelize.sync({ force: true });
}

async function tableNames(sequelize: Sequelize): Promise<string[]> {
  return (await sequelize.getQueryInterface().showAllTables()).sort();
}

async function countRows(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const model of CONTENT_MODELS) {
    counts[model.tableName] = await model.count();
  }
  return counts;
}

// Needs no database: port 1 refuses every connection at once, so a guard that
// let the run through would fail on the connection instead, with a different
// message. The refusal being the error is what shows nothing was reached.
test('NODE_ENV=production exits non-zero before touching the database, --force or not', async () => {
  const run = await runSeed(
    {
      ...process.env,
      NODE_ENV: 'production',
      // Set so the config parses: the refusal under test is the seed's own,
      // not production's missing MAIL_DELIVERY or TRUST_PROXY.
      MAIL_DELIVERY: 'log',
      TRUST_PROXY: '0',
      DB_USER: 'u',
      DB_PASSWORD: 'p',
      DB_HOST: '127.0.0.1',
      DB_PORT: '1',
    },
    ['--force']
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /Refusing to seed: NODE_ENV is production/);
  assert.doesNotMatch(run.stderr, /ECONNREFUSED/);
});

const skip = await skipWithoutMysql();

describe('seed.ts without --force against real MySQL', { skip }, () => {
  let sequelize: Sequelize;

  before(async () => {
    const db = testDbConfig('seed');
    await ensureDatabase(db);
    sequelize = createSequelize(db);
    initModels(sequelize);
    await buildSchema(sequelize);

    const user = await User.create({
      login: 'SeedBystander',
      email: 'seedbystander@example.com',
      password: 'hunter2hunter2',
      firstName: 'Seed',
      lastName: 'Bystander',
    });
    await createCreditedBook(
      { title: 'Kept', description: 'Must survive a dry run', tags: [] },
      [user.id]
    );
  });

  after(async () => {
    await sequelize.close();
  });

  test('reports what it found, exits 0 and changes no row', async () => {
    const found = await countRows();

    const run = await runSeed({
      ...process.env,
      NODE_ENV: 'test',
      DB_NAME: TEST_DB_NAME,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(
        `Dry run: pass --force to delete these rows and reseed ${TEST_DB_NAME}\\b`
      )
    );
    assert.match(run.stdout, /users: 1\b/);
    assert.match(run.stdout, /books: 1\b/);
    // The tenth content table, reported like the other nine: this is what
    // would catch the seed's own CONTENT_MODELS not knowing about genres.
    assert.match(run.stdout, /genres: 0\b/);
    assert.doesNotMatch(run.stdout, /Seeded /);
    // Not stderr === '': a Node release may print its own warnings there. Only
    // the seed's are in question — no --force warning, no failure.
    assert.doesNotMatch(run.stderr, /\] (WARN|ERROR) /);
    assert.equal(found.users, 1);
    assert.deepEqual(await countRows(), found);
  });

  // Last in this suite: it drops the bystander's tables.
  test('builds the schema with sync() on a fresh database', async () => {
    const expected = await tableNames(sequelize);
    await sequelize.getQueryInterface().dropAllTables();

    const run = await runSeed({
      ...process.env,
      NODE_ENV: 'test',
      DB_NAME: TEST_DB_NAME,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(await tableNames(sequelize), expected);
  });
});

// After the dry run, in the same schema: node:test runs one file's suites in
// order, and the dry run's bystander would not survive this one.
describe('seed.ts --force against real MySQL', { skip }, () => {
  let sequelize: Sequelize;

  // The offending rows rather than a count, so a failure names them.
  const offending = (sql: string): Promise<object[]> =>
    sequelize.query(sql, { type: QueryTypes.SELECT });

  before(async () => {
    const db = testDbConfig('seed');
    await ensureDatabase(db);
    sequelize = createSequelize(db);
    initModels(sequelize);
    await buildSchema(sequelize);

    const run = await runSeed(
      { ...process.env, NODE_ENV: 'test', DB_NAME: TEST_DB_NAME },
      ['--force']
    );
    assert.equal(run.code, 0, run.stderr);
  });

  after(async () => {
    await sequelize.close();
  });

  // The seed writes through the models, past likeRepository's checks, so
  // nothing but this stops it writing a like the API would refuse.
  test('writes no like the API would refuse', async () => {
    assert.deepEqual(
      await offending(
        `SELECT l.id FROM likes l
         JOIN comments c ON c.id = l.commentId
         WHERE c.userId = l.userId OR c.tombstone IS NOT NULL`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT l.id FROM likes l
         JOIN book_authors ba ON ba.bookId = l.bookId AND ba.userId = l.userId`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT l.id FROM likes l
         LEFT JOIN comments c ON c.id = l.commentId
         JOIN books b ON b.id = COALESCE(l.bookId, c.bookId)
         WHERE b.status = 'draft'`
      ),
      []
    );
  });

  test('stores Last online, About and the hide flag for the demo Accounts', async () => {
    const rows = await offending(
      `SELECT login, about, showLastSeen, lastSeenAt, createdAt, updatedAt FROM users`
    );
    const byLogin = new Map(
      rows.map((row) => [
        (row as { login: string }).login,
        row as Record<string, unknown>,
      ])
    );

    const statuses = await offending(
      `SELECT login, status FROM users WHERE status <> 'active'`
    );
    assert.deepEqual(
      statuses
        .map((row) => row as { login: string; status: string })
        .sort((a, b) => a.login.localeCompare(b.login)),
      [
        { login: 'blocked1', status: 'blocked' },
        { login: 'pending1', status: 'pending' },
      ]
    );
    assert.equal(byLogin.get('user3')?.showLastSeen, 0);
    assert.notEqual(byLogin.get('user3')?.lastSeenAt, null);
    assert.equal(byLogin.get('user1')?.lastSeenAt, null);
    assert.match(String(byLogin.get('nquinn')?.about), /\n/);
    assert.equal(byLogin.get('admin')?.about, '');
    assert.deepEqual(
      await offending(`SELECT id FROM users WHERE lastSeenAt < createdAt`),
      []
    );
    // A seeded stamp is not an edit: the backdated updatedAt stays.
    assert.deepEqual(
      await offending(`SELECT id FROM users WHERE updatedAt <> createdAt`),
      []
    );
  });

  test('dates no comment or like before its account was created', async () => {
    assert.deepEqual(
      await offending(
        `SELECT c.id FROM comments c
         JOIN users u ON u.id = c.userId
         WHERE c.createdAt < u.createdAt`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT l.id FROM likes l
         JOIN users u ON u.id = l.userId
         WHERE l.createdAt < u.createdAt`
      ),
      []
    );
  });

  // Written through the models, past favoriteRepository's visibility check,
  // so nothing but this stops the seed favoriting what a reader cannot see.
  test('gives every reader favorites, and none the API would refuse', async () => {
    assert.deepEqual(
      await offending(
        `SELECT u.login FROM users u
         LEFT JOIN favorites f ON f.userId = u.id
         WHERE u.role = 'user' AND u.status = 'active'
         GROUP BY u.id, u.login
         HAVING COUNT(f.id) = 0`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT f.id FROM favorites f
         JOIN users u ON u.id = f.userId
         WHERE u.role <> 'user' OR f.createdAt < u.createdAt`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT f.id FROM favorites f
         JOIN books b ON b.id = f.bookId
         WHERE b.status = 'draft'`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT f.id FROM favorites f
         WHERE f.seriesId IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM books b
             WHERE b.seriesId = f.seriesId AND b.status <> 'draft'
           )`
      ),
      []
    );
  });

  test('writes the planned Library, none of it on a Draft book', async () => {
    const plan = buildPlan(createRng(RNG_SEED));
    assert.equal(await LibraryEntry.count(), plan.library.length);
    assert.deepEqual(
      await offending(
        `SELECT e.id FROM library_entries e
         JOIN books b ON b.id = e.bookId
         WHERE b.status = 'draft'`
      ),
      []
    );
  });

  test('writes the planned Reading lists, none holding a Draft Book or a hidden Series', async () => {
    const plan = buildPlan(createRng(RNG_SEED));
    assert.equal(await ReadingList.count(), plan.readingLists.length);
    assert.equal(
      await ReadingListItem.count(),
      plan.readingLists.reduce((sum, list) => sum + list.items.length, 0)
    );
    assert.deepEqual(
      await offending(
        `SELECT i.id FROM reading_list_items i
         LEFT JOIN books b ON b.id = i.bookId
         WHERE b.status = 'draft'
            OR (i.seriesId IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM books s WHERE s.seriesId = i.seriesId AND s.status <> 'draft'))`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT listId, COUNT(*) AS n, MAX(position) AS top FROM reading_list_items
         GROUP BY listId HAVING top <> n - 1`
      ),
      []
    );
  });

  test('titles no chapter "X and X" or "A" before a vowel sound', async () => {
    assert.deepEqual(
      await offending(
        `SELECT title FROM chapters
         WHERE title LIKE '% and %'
           AND SUBSTRING_INDEX(title, ' and ', 1) = SUBSTRING_INDEX(title, ' and ', -1)`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT title FROM chapters
         WHERE title COLLATE utf8mb4_bin REGEXP '^A ([AEIOU]|Honest )'`
      ),
      []
    );
  });

  test('creates the Genre tree: five top-level Genres, their Subgenres, and only those', async () => {
    const rows = await Genre.findAll({ order: [['name', 'ASC']] });
    const nameOf = new Map(rows.map((row) => [row.id, row.name]));
    const tree = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) tree.set(row.name, tree.get(row.name) ?? []);
    }
    for (const row of rows) {
      if (row.parentId !== null) {
        tree.get(nameOf.get(row.parentId) ?? '')?.push(row.name);
      }
    }
    assert.deepEqual([...tree.keys()].sort(), [
      'Fantasy',
      'Horror',
      'Mystery',
      'Romance',
      'Science Fiction',
    ]);
    assert.deepEqual(tree.get('Horror'), ['Gothic']);
    assert.deepEqual(tree.get('Science Fiction')?.sort(), [
      'Cyberpunk',
      'Dystopia',
      'Hard SF',
      'Space Opera',
    ]);
    assert.deepEqual(tree.get('Fantasy')?.sort(), [
      'Dark Fantasy',
      'Epic Fantasy',
      'Fairy Tale',
      'Sword and Sorcery',
      'Urban Fantasy',
    ]);
    assert.deepEqual(tree.get('Mystery'), []);
    for (const subgenres of tree.values()) assert.ok(subgenres.length <= 10);
  });

  test('files every book and series under a Genre at both levels, and leaves some Genres empty', async () => {
    assert.deepEqual(
      await offending('SELECT id FROM books WHERE genreId IS NULL'),
      []
    );
    assert.deepEqual(
      await offending('SELECT id FROM series WHERE genreId IS NULL'),
      []
    );
    for (const table of ['books', 'series']) {
      const atTop = await offending(
        `SELECT t.id FROM ${table} t JOIN genres g ON g.id = t.genreId
         WHERE g.parentId IS NULL AND EXISTS (SELECT 1 FROM genres c WHERE c.parentId = g.id)`
      );
      const atSub = await offending(
        `SELECT t.id FROM ${table} t JOIN genres g ON g.id = t.genreId WHERE g.parentId IS NOT NULL`
      );
      assert.ok(
        atTop.length > 0,
        `${table} point at a top-level Genre with Subgenres`
      );
      assert.ok(atSub.length > 0, `${table} point at a Subgenre`);
    }
    // Mystery has no Subgenre and no work: the empty state the demo shows.
    assert.deepEqual(
      await offending(
        `SELECT g.id FROM genres g LEFT JOIN books b ON b.genreId = g.id
         LEFT JOIN series s ON s.genreId = g.id
         WHERE g.name = 'Mystery' AND (b.id IS NOT NULL OR s.id IS NOT NULL)`
      ),
      []
    );
  });

  // The seed writes chapters with bulkCreate, which skips per-instance hooks:
  // this fails first if the count ever moves from the text setter to a hook.
  test('stores a word count in step with every chapter text', async () => {
    const chapters = await Chapter.findAll({
      attributes: ['id', 'text', 'wordCount'],
    });

    assert.ok(chapters.length > 0);
    assert.deepEqual(
      chapters
        .filter(
          (chapter) =>
            chapter.wordCount === 0 ||
            chapter.wordCount !== countWords(chapter.text)
        )
        .map((chapter) => chapter.id),
      []
    );
  });

  test('writes Reports in every status and an Account at the ban mark', async () => {
    const statuses = await offending('SELECT DISTINCT status FROM reports');
    assert.equal(statuses.length, 4);
    const banned = await offending(
      `SELECT reportedAccountId FROM reports WHERE status = 'upheld'
       GROUP BY reportedAccountId HAVING COUNT(DISTINCT commentId) >= 10`
    );
    assert.ok(banned.length >= 1);
  });

  test('writes no Report the API would refuse', async () => {
    for (const sql of [
      `SELECT r.id FROM reports r JOIN comments c ON c.id = r.commentId WHERE r.reporterId = c.userId OR r.createdAt < c.createdAt`,
      `SELECT r.id FROM reports r JOIN comments c ON c.id = r.commentId
       WHERE r.status IN ('new', 'in_review') AND c.tombstone IS NOT NULL`,
      `SELECT commentId FROM reports WHERE status IN ('new', 'in_review') GROUP BY commentId HAVING COUNT(*) > 1`,
      `SELECT r.id FROM reports r JOIN users u ON u.id = r.reporterId WHERE r.createdAt < u.createdAt`,
    ]) {
      assert.deepEqual(await offending(sql), [], sql);
    }
  });

  // Otherwise the first announcement pass after a seed would mail every
  // Favorite holder about the whole catalogue (ADR-0013).
  test('marks every Published chapter and book announced, and leaves Scheduled chapters for the pass', async () => {
    assert.deepEqual(
      await offending(
        `SELECT c.id FROM chapters c
         JOIN books b ON b.id = c.bookId
         WHERE b.status <> 'draft' AND c.publishedAt <= NOW(3)
           AND c.announcedAt IS NULL`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT b.id FROM books b
         WHERE b.status <> 'draft' AND b.announcedAt IS NULL
           AND EXISTS (SELECT 1 FROM chapters c
                       WHERE c.bookId = b.id AND c.publishedAt <= NOW(3))`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT c.id FROM chapters c
         WHERE (c.publishedAt IS NULL OR c.publishedAt > NOW(3))
           AND c.announcedAt IS NOT NULL`
      ),
      []
    );
    assert.deepEqual(
      await offending(
        `SELECT b.id FROM books b
         WHERE b.status = 'draft' AND b.announcedAt IS NOT NULL`
      ),
      []
    );
    const [scheduled] = await sequelize.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM chapters WHERE publishedAt > NOW(3)`,
      { type: QueryTypes.SELECT }
    );
    assert.ok(
      Number(scheduled?.count) > 0,
      'the seed writes Scheduled chapters for the pass to announce'
    );
  });
});
