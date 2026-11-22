import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema as s } from "../db";
import { ah, ok, parse } from "../utils/http";
import { bad, conflict, forbidden, notFound } from "../utils/errors";
import { addPoints, getRules } from "../services/loyalty";
import { emitTo, rooms } from "../sockets";

export const gamesRouter = Router();

const TRIVIA = [
  { q: "Which country is the origin of espresso?", o: ["Italy", "France", "Brazil", "India"], a: 0 }, { q: "Which bean is more commonly used for specialty coffee?", o: ["Robusta", "Arabica", "Liberica", "Excelsa"], a: 1 },
  { q: "How many hours are in a day?", o: ["12", "24", "36", "48"], a: 1 }, { q: "What is the capital of India?", o: ["Mumbai", "Kolkata", "New Delhi", "Chennai"], a: 2 },
  { q: "Which planet is known as the Red Planet?", o: ["Venus", "Mars", "Jupiter", "Saturn"], a: 1 }, { q: "How many continents are there?", o: ["5", "6", "7", "8"], a: 2 },
  { q: "Which ocean is the largest?", o: ["Atlantic", "Indian", "Arctic", "Pacific"], a: 3 }, { q: "Who painted the Mona Lisa?", o: ["Da Vinci", "Van Gogh", "Picasso", "Monet"], a: 0 },
];
const FOOD = [
  { q: "Which cheese is traditional on a Margherita pizza?", o: ["Cheddar", "Mozzarella", "Feta", "Gouda"], a: 1 }, { q: "A cappuccino is espresso with steamed milk and…", o: ["Cream", "Foam", "Chocolate", "Ice"], a: 1 },
  { q: "Which grain is used in a classic risotto?", o: ["Basmati", "Arborio", "Jasmine", "Sona Masoori"], a: 1 }, { q: "Tiramisu traditionally contains which ingredient?", o: ["Mascarpone", "Paneer", "Tofu", "Curd"], a: 0 },
  { q: "Which spice gives biryani its yellow colour?", o: ["Saffron", "Cumin", "Clove", "Pepper"], a: 0 }, { q: "Pesto is traditionally made primarily with…", o: ["Basil", "Mint", "Coriander", "Parsley"], a: 0 },
  { q: "Croissants originate from which country's baking tradition?", o: ["Italy", "Austria/France", "Spain", "Germany"], a: 1 }, { q: "What is a flat white's main ingredient besides milk?", o: ["Espresso", "Matcha", "Chai", "Cocoa"], a: 0 },
];
const shuffle = <T,>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const MAX_ROUND_PTS = 3; // eligible loyalty points per game round; also capped per day by rules.gameDailyCap

async function award(ctx: { rid: string; customerId: string | null; sessionId: string }, game: string, score: number, points: number, tableId: string, gameSessionId?: string) {
  let granted = 0;
  const [row] = await db.transaction(async (tx) => {
    if (ctx.customerId && points > 0) {
      const rules = await getRules(ctx.rid, tx);
      const day = new Date().toISOString().slice(0, 10);
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(sum(${s.gameScores.rewardPoints}),0)` }).from(s.gameScores).innerJoin(s.customerSessions, eq(s.customerSessions.id, s.gameScores.customerSessionId)).where(and(eq(s.customerSessions.customerId, ctx.customerId), gte(s.gameScores.createdAt, new Date(day))));
      granted = Math.max(0, Math.min(points, rules.gameDailyCap - Number(n)));
    }
    const r = await tx.insert(s.gameScores).values({ restaurantId: ctx.rid, customerSessionId: ctx.sessionId, tableId, game, score, rewardPoints: granted, gameSessionId }).returning();
    if (granted > 0) await addPoints(ctx.rid, ctx.customerId!, granted, "BONUS", `game:${r[0].id}`, `Game: ${game}`, tx);
    return r;
  });
  emitTo(rooms.staff(ctx.rid), "game:score_updated", { game, score, tableId });
  return { ...row, rewardPoints: granted };
}

// ---- quizzes: answers never leave the server ----
gamesRouter.post("/quiz/:kind/start", ah(async (req, res) => {
  const kind = String(req.params.kind); if (!["trivia", "food"].includes(kind)) throw notFound("Unknown quiz");
  const bank = kind === "food" ? FOOD : TRIVIA;
  const picked = shuffle(bank).slice(0, 5);
  const [g] = await db.insert(s.gameSessions).values({ restaurantId: req.cust!.rid, game: `quiz:${kind}`, tableId: req.cust!.tableId, state: { answers: picked.map((x) => x.a), owner: req.cust!.sessionId, startedAt: Date.now() } }).returning();
  ok(res, { id: g.id, questions: picked.map((x) => ({ q: x.q, options: x.o })) });
}));
gamesRouter.post("/quiz/:id/submit", ah(async (req, res) => {
  const b = parse(z.object({ answers: z.array(z.number().int().min(0).max(3)).length(5) }), req.body);
  const [g] = await db.select().from(s.gameSessions).where(and(eq(s.gameSessions.id, String(req.params.id)), eq(s.gameSessions.restaurantId, req.cust!.rid)));
  const st = g?.state as any;
  if (!g || st.owner !== req.cust!.sessionId) throw notFound("Quiz not found");
  if (g.status !== "OPEN") throw conflict("Quiz already submitted");
  if (Date.now() - st.startedAt < 3000) throw bad("Submitted too quickly");
  const correct = b.answers.filter((a, i) => a === st.answers[i]).length;
  const speedBonus = Math.max(0, 60 - Math.floor((Date.now() - st.startedAt) / 1000));
  const score = correct * 100 + speedBonus;
  const [upd] = await db.update(s.gameSessions).set({ status: "DONE" }).where(and(eq(s.gameSessions.id, g.id), eq(s.gameSessions.status, "OPEN"))).returning();
  if (!upd) throw conflict("Quiz already submitted");
  const r = await award({ rid: req.cust!.rid, customerId: req.cust!.customerId, sessionId: req.cust!.sessionId }, g.game, score, Math.min(MAX_ROUND_PTS, correct), req.cust!.tableId, g.id);
  ok(res, { correct, total: 5, score, correctAnswers: st.answers, rewardPoints: r.rewardPoints });
}));
// ---- memory match: server verifies plausibility ----
gamesRouter.post("/memory/score", ah(async (req, res) => {
  const b = parse(z.object({ moves: z.number().int().min(8).max(200), seconds: z.number().min(6).max(900) }), req.body);
  const score = Math.max(0, 1000 - b.moves * 15 - Math.round(b.seconds) * 2);
  const r = await award({ rid: req.cust!.rid, customerId: req.cust!.customerId, sessionId: req.cust!.sessionId }, "memory", score, score > 500 ? 2 : 1, req.cust!.tableId);
  ok(res, { score, rewardPoints: r.rewardPoints });
}));
// ---- spin the wheel: once per table session per customer session, RNG on server ----
const WHEEL = [{ label: "Better luck next time", pts: 0, w: 40 }, { label: "5 points", pts: 5, w: 30 }, { label: "10 points", pts: 10, w: 20 }, { label: "20 points", pts: 20, w: 10 }];
gamesRouter.post("/spin", ah(async (req, res) => {
  const [done] = await db.select().from(s.gameScores).where(and(eq(s.gameScores.customerSessionId, req.cust!.sessionId), eq(s.gameScores.game, "spin")));
  if (done) throw conflict("You have already spun the wheel on this visit");
  let roll = Math.random() * 100; const prize = WHEEL.find((w) => (roll -= w.w) < 0) || WHEEL[0];
  const r = await award({ rid: req.cust!.rid, customerId: req.cust!.customerId, sessionId: req.cust!.sessionId }, "spin", prize.pts, prize.pts, req.cust!.tableId);
  ok(res, { prize: prize.label, points: prize.pts, rewardPoints: r.rewardPoints, identified: !!req.cust!.customerId, wheel: WHEEL.map((w) => w.label), note: !req.cust!.customerId && prize.pts ? "Sign in with your phone to claim points" : undefined });
}));

// ---- tic-tac-toe: server-authoritative, same table or cross-table challenge ----
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const winner = (b: string[]) => { for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x]; return b.every(Boolean) ? "DRAW" : null; };
const view = (g: typeof s.gameSessions.$inferSelect) => ({ id: g.id, status: g.status, ...(g.state as any) });
gamesRouter.post("/ttt", ah(async (req, res) => {
  const c = req.cust!;
  const b = parse(z.object({ targetTable: z.number().int().optional() }), req.body);
  let target: string | null = null;
  if (b.targetTable) { const [t] = await db.select().from(s.cafeTables).where(and(eq(s.cafeTables.restaurantId, c.rid), eq(s.cafeTables.number, b.targetTable))); if (!t) throw notFound("Table not found"); if (t.id === c.tableId) throw bad("Pick another table"); target = t.id; }
  const [g] = await db.insert(s.gameSessions).values({ restaurantId: c.rid, game: "tictactoe", tableId: c.tableId, state: { board: Array(9).fill(""), turn: "X", players: { X: c.sessionId, O: null }, tables: { X: c.tableId, O: null }, targetTableId: target, winner: null } }).returning();
  if (target) emitTo(rooms.table(c.rid, target), "game:challenge_created", { gameId: g.id, fromTable: c.tableId, game: "tictactoe" });
  else emitTo(rooms.table(c.rid, c.tableId), "game:challenge_created", { gameId: g.id, fromTable: c.tableId, game: "tictactoe" });
  ok(res, view(g), 201);
}));
gamesRouter.get("/ttt/open", ah(async (req, res) => {
  const c = req.cust!;
  const list = await db.select().from(s.gameSessions).where(and(eq(s.gameSessions.restaurantId, c.rid), eq(s.gameSessions.game, "tictactoe"), eq(s.gameSessions.status, "OPEN")));
  ok(res, list.map(view).filter((g: any) => !g.players.O && g.players.X !== c.sessionId && (g.targetTableId ? g.targetTableId === c.tableId : g.tables.X === c.tableId)));
}));
gamesRouter.get("/ttt/:id", ah(async (req, res) => {
  const [g] = await db.select().from(s.gameSessions).where(and(eq(s.gameSessions.id, String(req.params.id)), eq(s.gameSessions.restaurantId, req.cust!.rid)));
  if (!g) throw notFound("Game not found"); ok(res, view(g));
}));
gamesRouter.post("/ttt/:id/join", ah(async (req, res) => {
  const c = req.cust!;
  const out = await db.transaction(async (tx) => {
    const [g] = await tx.select().from(s.gameSessions).where(and(eq(s.gameSessions.id, String(req.params.id)), eq(s.gameSessions.restaurantId, c.rid))).for("update");
    if (!g || g.status !== "OPEN") throw notFound("Game not available");
    const st = g.state as any;
    if (st.players.O) throw conflict("Game already has two players");
    if (st.players.X === c.sessionId) throw bad("You created this game");
    if (st.targetTableId ? st.targetTableId !== c.tableId : st.tables.X !== c.tableId) throw forbidden("This game is not open to your table");
    st.players.O = c.sessionId; st.tables.O = c.tableId;
    const [u] = await tx.update(s.gameSessions).set({ state: st }).where(eq(s.gameSessions.id, g.id)).returning(); return u;
  });
  emitTo(rooms.game(out.id), "game:state", view(out)); ok(res, view(out));
}));
gamesRouter.post("/ttt/:id/move", ah(async (req, res) => {
  const c = req.cust!; const b = parse(z.object({ cell: z.number().int().min(0).max(8) }), req.body);
  const out = await db.transaction(async (tx) => {
    const [g] = await tx.select().from(s.gameSessions).where(and(eq(s.gameSessions.id, String(req.params.id)), eq(s.gameSessions.restaurantId, c.rid))).for("update");
    if (!g || g.status !== "OPEN") throw notFound("Game not available");
    const st = g.state as any;
    if (!st.players.O) throw conflict("Waiting for an opponent");
    const mark = st.players.X === c.sessionId ? "X" : st.players.O === c.sessionId ? "O" : null;
    if (!mark) throw forbidden("You are not in this game");
    if (st.turn !== mark) throw conflict("Not your turn");
    if (st.board[b.cell]) throw bad("Cell taken");
    st.board[b.cell] = mark; st.winner = winner(st.board); st.turn = mark === "X" ? "O" : "X";
    const [u] = await tx.update(s.gameSessions).set({ state: st, status: st.winner ? "DONE" : "OPEN" }).where(eq(s.gameSessions.id, g.id)).returning();
    return u;
  });
  const st = out.state as any;
  emitTo(rooms.game(out.id), "game:state", view(out));
  if (st.winner) {
    for (const m of ["X", "O"] as const) {
      const sessionId = st.players[m];
      const [cs] = await db.select().from(s.customerSessions).where(eq(s.customerSessions.id, sessionId));
      const pts = st.winner === m ? 10 : st.winner === "DRAW" ? 3 : 1;
      await award({ rid: c.rid, customerId: cs?.customerId ?? null, sessionId }, "tictactoe", pts, st.winner === m ? 2 : 0, st.tables[m], out.id);
    }
  }
  ok(res, view(out));
}));

gamesRouter.get("/leaderboard", ah(async (req, res) => {
  const game = req.query.game ? String(req.query.game) : null; const days = Math.min(365, Number(req.query.days) || 7);
  const since = new Date(Date.now() - days * 86400000);
  const where = and(eq(s.gameScores.restaurantId, req.cust!.rid), gte(s.gameScores.createdAt, since), ...(game ? [eq(s.gameScores.game, game)] : []));
  const players = await db.select({ name: sql<string>`coalesce(${s.customerSessions.displayName}, 'Guest')`, table: s.cafeTables.number, game: s.gameScores.game, total: sql<number>`sum(${s.gameScores.score})` }).from(s.gameScores)
    .innerJoin(s.customerSessions, eq(s.customerSessions.id, s.gameScores.customerSessionId)).leftJoin(s.cafeTables, eq(s.cafeTables.id, s.gameScores.tableId)).where(where)
    .groupBy(s.customerSessions.id, s.customerSessions.displayName, s.cafeTables.number, s.gameScores.game).orderBy(desc(sql`sum(${s.gameScores.score})`)).limit(20);
  const tables = await db.select({ table: s.cafeTables.number, total: sql<number>`sum(${s.gameScores.score})` }).from(s.gameScores).innerJoin(s.cafeTables, eq(s.cafeTables.id, s.gameScores.tableId)).where(where).groupBy(s.cafeTables.number).orderBy(desc(sql`sum(${s.gameScores.score})`)).limit(10);
  ok(res, { players, tables });
}));
