(function () {
  const SEA = "SEA";
  const LAST_WEEK = 18;

  const els = {
    heroWeek: document.getElementById("hero-week"),
    weekChip: document.getElementById("week-chip"),
    prevWeek: document.getElementById("prev-week"),
    nextWeek: document.getElementById("next-week"),
    featured: document.getElementById("featured"),
    featuredTeams: document.getElementById("featured-teams"),
    featuredWhen: document.getElementById("featured-when"),
    featuredClock: document.getElementById("featured-clock"),
    weekBoard: document.getElementById("week-board"),
    liveBanner: document.getElementById("live-banner"),
    liveCount: document.getElementById("live-count"),
    standings: document.getElementById("standings-root"),
    teams: document.getElementById("teams-root"),
    projections: document.getElementById("projections-root"),
    projectionsMeta: document.getElementById("projections-meta"),
    roadTile: document.getElementById("road-tile"),
    roadTileCopy: document.getElementById("road-tile-copy"),
    roadOverlay: document.getElementById("road-overlay"),
    roadRoot: document.getElementById("road-root"),
    roadControls: document.getElementById("road-controls"),
    roadMeta: document.getElementById("road-meta"),
    roadFlag: document.getElementById("road-flag"),
    schedule: document.getElementById("schedule-list"),
    scheduleTitle: document.getElementById("schedule-title"),
    scheduleMeta: document.getElementById("schedule-meta"),
    status: document.getElementById("data-status"),
    refresh: document.getElementById("refresh-button"),
    views: document.querySelectorAll("[data-view]"),
    panels: document.querySelectorAll("[data-panel]"),
    filters: document.querySelectorAll("[data-filter]"),
  };

  const state = {
    seasonYear: Season.currentNflSeasonYear(),
    currentWeek: 1,
    week: 1,
    cache: new Map(),
    records: {},
    games: [],
    nextGame: null,
    source: "Loading schedule…",
    filter: "all",
    view: "nfl",
    featuredKickoff: 0,
    liveCount: 0,
    selectedTeam: null,
    teamFilter: "all",
    teamFromMatchup: false,
    selectedGameId: null,
    matchupWeek: null,
    teamSchedules: new Map(),
    projView: "all",
    projDivision: "",
    modelStore: null,
    picks: {},
    modelToken: 0,
    modelReady: false,
    dataUpdatedAt: null,
    projLoading: "",
    pickNote: null,
    roadOpen: false,
    roadView: "chart",
    roadConference: "all",
    roadDivision: "",
    roadTeam: null,
    roadResult: null,
    roadSignature: "",
    roadLoading: false,
    roadError: "",
    roadToken: 0,
    officialGames: null,
    officialChecked: false,
    officialKey: "",
    officialToken: 0,
  };

  state.modelStore = readStore(modelStorageKey()) || emptyStore();
  if (!state.modelStore.predictions) state.modelStore = emptyStore();
  state.picks = readStore(picksStorageKey()) || {};
  if (!state.picks || Array.isArray(state.picks)) state.picks = {};
  state.conferenceTried = {};

  function emptyStore() {
    return {
      season: state.seasonYear,
      model: "margin-v1",
      predictions: {},
      turnovers: {},
      snapshots: {},
      roadHistory: [],
      updatedAt: null,
      turnoversAt: null,
    };
  }

  function modelStorageKey() {
    return `nfl-gameday-model-${state.seasonYear}`;
  }

  function picksStorageKey() {
    return `nfl-gameday-picks-${state.seasonYear}`;
  }

  function readStore(key) {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : null;
    } catch (error) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* The page still works if the browser rejects storage. */
    }
  }

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function logoImg(abbr, className) {
    const img = el("img", className);
    const info = League.team(abbr);
    img.src = League.logo(abbr);
    img.alt = info.name;
    if (League.norm(abbr) === SEA) {
      img.addEventListener("error", () => {
        img.src = "assets/seahawks-helmet.png";
      });
    }
    return img;
  }

  function scoreText(score) {
    if (score == null || score === "") return "0";
    if (typeof score === "number") return String(score);
    if (typeof score === "string") return score;
    if (typeof score === "object") return String(score.displayValue ?? score.value ?? "0");
    return "0";
  }

  function periodLabel(period) {
    if (period > 4) return "OT";
    return ["", "1st", "2nd", "3rd", "4th"][period] || "";
  }

  function liveDetail(game) {
    const parts = [periodLabel(game.period)];
    if (game.clock && game.clock !== "0:00") parts.push(game.clock);
    return parts.filter(Boolean).join(" · ");
  }

  function recordFor(abbr, fallback) {
    const saved = state.records[League.norm(abbr)];
    if (saved && saved.summary) return saved.summary;
    return fallback || "—";
  }

  function whenLine(ms) {
    const date = Season.formatShortDate(ms).toUpperCase();
    return `${Season.formatGameDay(ms)} · ${date} · ${Season.formatKickoff(ms)}`;
  }

  function signature(games) {
    return games
      .map((game) => [game.id, game.status, scoreText(game.away.score), scoreText(game.home.score), game.clock].join(":"))
      .join("|");
  }

  async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Could not load ${url}`);
    return response.json();
  }

  async function fetchWeek(week) {
    if (state.cache.has(week)) return state.cache.get(week);
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${state.seasonYear}&seasontype=2&week=${week}`;
    const parsed = League.parseScoreboard(await fetchJson(url));
    state.cache.set(week, parsed.games);
    return parsed.games;
  }

  async function loadSeason() {
    const schedule = await fetchJson(`data/schedules/${state.seasonYear}.json`);
    try {
      const payload = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/26/schedule?season=${state.seasonYear}`);
      state.games = Season.gamesFromEspn(payload);
      state.teamSchedules.set("SEA", League.parseTeamSchedule(payload, "26"));
      state.source = "Live NFL schedule";
    } catch (error) {
      state.games = Season.gamesFromSchedule(schedule);
      state.source = "Saved Seahawks schedule · league feed unavailable";
    }
    state.nextGame = Season.findNextGame(state.games);
  }

  function seattleGame(games) {
    return (games || []).find((game) => League.involves(game, SEA)) || null;
  }

  function outlookFor(abbr) {
    const weeks = [state.currentWeek, state.currentWeek + 1].filter((week) => week >= 1 && week <= LAST_WEEK);
    const games = weeks.flatMap((week) => state.cache.get(week) || []);
    const mine = games
      .filter((game) => League.involves(game, abbr))
      .sort((a, b) => a.kickoffMs - b.kickoffMs);
    return mine.find((game) => game.status !== "post") || mine[mine.length - 1] || null;
  }

  function renderWeekControls() {
    setText(els.heroWeek, `Week ${state.week}`);
    setText(els.weekChip, `Week ${state.week}`);
    els.prevWeek.disabled = state.week <= 1;
    els.nextWeek.disabled = state.week >= LAST_WEEK;
  }

  function renderLiveBanner() {
    const games = state.cache.get(state.currentWeek) || [];
    const live = games.filter((game) => game.status === "in");
    state.liveCount = live.length;
    els.liveBanner.hidden = live.length === 0;
    if (live.length) {
      setText(els.liveCount, live.length === 1 ? "1 game on the field" : `${live.length} games on the field`);
    }
  }

  function squad(side, place) {
    const info = League.team(side.abbr);
    const wrap = el("div", "squad");
    wrap.append(logoImg(side.abbr));
    wrap.append(el("h3", "", info.short));
    wrap.append(el("p", "abbr", info.abbr));
    wrap.append(el("p", "record", recordFor(side.abbr, side.record)));
    wrap.append(el("span", "place-chip", place));
    return wrap;
  }

  function countdownBoard(kickoffMs) {
    const board = el("div", "scoreboard");
    const caption = el("p", "", "Kickoff in");
    caption.id = "countdown-caption";
    board.append(caption);
    [
      ["days", "Days"],
      ["hours", "Hrs"],
      ["minutes", "Min"],
      ["seconds", "Sec"],
    ].forEach(([unit, label]) => {
      const well = el("div", "well");
      const strong = el("strong", "", "00");
      strong.dataset.kickoff = String(kickoffMs);
      strong.dataset.unit = unit;
      if (unit === "days") strong.id = "count-days";
      well.append(strong, el("span", "", label));
      board.append(well);
    });
    return board;
  }

  function resultBoard(game) {
    const board = el("div", "result-board");
    const chip = el("span", `result-chip ${game.status === "in" ? "live" : "final"}`, game.status === "in" ? "Live" : "Final");
    const scores = el("div", "score-stack");
    scores.append(el("div", "", `${game.away.abbr} ${scoreText(game.away.score)}`));
    scores.append(el("div", "", `${game.home.abbr} ${scoreText(game.home.score)}`));
    board.append(chip, scores);
    if (game.status === "in") board.append(el("p", "clock-detail", liveDetail(game)));
    return board;
  }

  function renderFeatured() {
    const games = state.cache.get(state.week) || [];
    const game = seattleGame(games);
    els.featured.classList.toggle("is-seattle", true);
    els.featuredTeams.replaceChildren();
    els.featuredClock.replaceChildren();
    state.featuredKickoff = 0;

    if (!game) {
      const upcoming = state.nextGame;
      setText(els.featuredWhen, `Bye week · no Seattle game in week ${state.week}`);
      if (!upcoming) {
        els.featuredTeams.append(el("p", "empty", "Seattle's next kickoff is not on the schedule yet."));
        return;
      }
      const opponent = {
        abbr: League.norm(upcoming.opponentAbbr),
        record: recordFor(upcoming.opponentAbbr),
      };
      const seattle = { abbr: SEA, record: recordFor(SEA) };
      els.featuredTeams.append(
        squad(seattle, upcoming.isHome ? "Home" : "Away"),
        el("div", "versus", upcoming.isHome ? "VS" : "@"),
        squad(opponent, upcoming.isHome ? "Away" : "Home")
      );
      setText(els.featuredWhen, `Next kickoff · ${whenLine(upcoming.kickoffMs)}`);
      state.featuredKickoff = upcoming.kickoffMs;
      els.featuredClock.append(countdownBoard(upcoming.kickoffMs));
      return;
    }

    const seattleSide = game.home.abbr === SEA ? game.home : game.away;
    const otherSide = game.home.abbr === SEA ? game.away : game.home;
    const seattleHome = game.home.abbr === SEA;
    els.featuredTeams.append(
      squad(seattleSide, seattleHome ? "Home" : "Away"),
      el("div", "versus", "VS"),
      squad(otherSide, seattleHome ? "Away" : "Home")
    );
    const venue = game.venue ? ` · ${game.venue}` : "";
    setText(els.featuredWhen, `${whenLine(game.kickoffMs)}${venue}`);
    if (game.status === "pre") {
      state.featuredKickoff = game.kickoffMs;
      els.featuredClock.append(countdownBoard(game.kickoffMs));
    } else {
      els.featuredClock.append(resultBoard(game));
    }
  }

  function gameKey(game) {
    return game.id || `${game.away.abbr}@${game.home.abbr}@${game.kickoffMs}`;
  }

  function currentMatchup() {
    if (!state.selectedGameId || !state.matchupWeek) return null;
    const games = state.cache.get(state.matchupWeek) || [];
    return games.find((game) => gameKey(game) === state.selectedGameId) || null;
  }

  function scrollToBoard() {
    const heading = document.getElementById("week-heading");
    if (heading) heading.scrollIntoView({ block: "start" });
  }

  function openMatchup(game) {
    state.selectedGameId = gameKey(game);
    state.matchupWeek = game.week || state.week;
    renderWeekBoard(false);
    tick();
    scrollToBoard();
  }

  function closeMatchup() {
    state.selectedGameId = null;
    state.matchupWeek = null;
    renderWeekBoard(false);
    scrollToBoard();
  }

  function returnToMatchup() {
    state.selectedTeam = null;
    state.teamFromMatchup = false;
    const week = state.matchupWeek || state.week;
    showView("nfl");
    if (week !== state.week) {
      showWeek(week, false).then(scrollToBoard);
      return;
    }
    renderWeekBoard(false);
    tick();
    scrollToBoard();
  }

  function matchupSide(side, place) {
    const info = League.team(side.abbr);
    const button = el("button", "matchup-team");
    button.type = "button";
    button.style.setProperty("--team", info.color);
    button.setAttribute("aria-label", `${info.name}, view team schedule`);
    button.append(logoImg(side.abbr, "matchup-logo"));
    button.append(el("h3", "", info.name));
    button.append(el("p", "abbr", info.abbr));
    button.append(el("p", "record", recordFor(side.abbr, side.record)));
    button.append(el("span", "place-chip", place));
    button.append(el("span", "schedule-cue", "View team schedule →"));
    button.addEventListener("click", () => {
      showView("teams");
      openTeam(side.abbr, "matchup");
    });
    return button;
  }

  function renderMatchup(game) {
    const wrap = el("div", "matchup");
    if (game.status === "in") wrap.classList.add("is-live");
    if (League.involves(game, SEA)) wrap.classList.add("is-seattle");

    const back = el("button", "back-link", `← Back to week ${state.matchupWeek || state.week}`);
    back.type = "button";
    back.addEventListener("click", closeMatchup);

    const teams = el("div", "matchup-teams");
    teams.append(matchupSide(game.away, "Away"), el("div", "versus", "VS"), matchupSide(game.home, "Home"));

    const meta = el("div", "matchup-meta");
    const venue = game.venue ? ` · ${game.venue}` : "";
    meta.append(el("p", "jumbo-when", `${whenLine(game.kickoffMs)}${venue}`));
    if (game.status === "pre") {
      const count = el("p", "mini-count", "");
      count.dataset.kickoff = String(game.kickoffMs);
      count.dataset.unit = "all";
      meta.append(count);
      meta.append(el("span", "result-chip upcoming", "Upcoming"));
    } else {
      const awayScore = League.numericScore(game.away.score);
      const homeScore = League.numericScore(game.home.score);
      const scores = el("p", "scoreline matchup-score");
      scores.append(
        el("span", awayScore != null && homeScore != null && awayScore > homeScore ? "is-winner" : "", `${game.away.abbr} ${awayScore == null ? "—" : awayScore}`),
        document.createTextNode(" – "),
        el("span", awayScore != null && homeScore != null && homeScore > awayScore ? "is-winner" : "", `${game.home.abbr} ${homeScore == null ? "—" : homeScore}`)
      );
      meta.append(scores);
      meta.append(el("span", `result-chip ${game.status === "in" ? "live" : "final"}`, game.status === "in" ? "Live" : "Final"));
      if (game.status === "in") meta.append(el("p", "clock-detail", liveDetail(game)));
    }

    wrap.append(back, teams, meta);
    return wrap;
  }

  function matchCard(game) {
    const card = el("button", "game-card");
    card.type = "button";
    const awayName = League.team(game.away.abbr).name;
    const homeName = League.team(game.home.abbr).name;
    card.setAttribute("aria-label", `${awayName} at ${homeName}`);
    card.style.setProperty("--away", League.team(game.away.abbr).color);
    card.style.setProperty("--home", League.team(game.home.abbr).color);
    if (League.involves(game, SEA)) card.classList.add("is-seattle");
    if (game.status === "in") card.classList.add("is-live");
    card.addEventListener("click", () => openMatchup(game));

    card.append(el("p", "card-when", whenLine(game.kickoffMs)));

    const match = el("div", "card-match");
    [game.away, game.home].forEach((side, index) => {
      const column = el("div");
      column.append(logoImg(side.abbr));
      column.append(el("strong", "", side.abbr));
      column.append(el("span", "mini-label", index === 0 ? "Away" : "Home"));
      const detail = game.status === "pre" ? recordFor(side.abbr, side.record) : scoreText(side.score);
      column.append(el("span", "card-rec", detail));
      match.append(column);
      if (index === 0) match.append(el("div", "versus", "VS"));
    });
    card.append(match);

    if (game.status !== "pre") {
      const status = el("div", "card-status");
      status.append(el("span", `result-chip ${game.status === "in" ? "live" : "final"}`, game.status === "in" ? "Live" : "Final"));
      if (game.status === "in") status.append(el("p", "clock-detail", liveDetail(game)));
      card.append(status);
    }
    return card;
  }

  function renderWeekBoard(animate) {
    const games = state.cache.get(state.week) || [];
    const matchup = state.week === state.matchupWeek ? currentMatchup() : null;
    els.weekBoard.replaceChildren();
    if (matchup) {
      els.weekBoard.append(renderMatchup(matchup));
      return;
    }
    if (state.selectedGameId && state.week === state.matchupWeek) {
      state.selectedGameId = null;
      state.matchupWeek = null;
    }
    if (!games.length) {
      els.weekBoard.append(el("p", "empty", "No games published for this week."));
      return;
    }
    games.forEach((game) => els.weekBoard.append(matchCard(game)));
    if (animate) restartMotion(els.weekBoard);
  }

  function ranked(abbrs) {
    return abbrs
      .map((abbr) => ({ abbr, record: state.records[abbr] || { wins: 0, losses: 0, ties: 0, diff: 0, summary: "—" } }))
      .sort((a, b) => b.record.wins - a.record.wins || a.record.losses - b.record.losses || b.record.diff - a.record.diff);
  }

  function nextLabel(abbr) {
    const game = outlookFor(abbr);
    if (!game) return "Bye";
    const home = game.home.abbr === League.norm(abbr);
    const other = home ? game.away.abbr : game.home.abbr;
    const mark = home ? "vs" : "@";
    if (game.status === "in") return `Live ${mark} ${other}`;
    if (game.status === "post") return `Final ${mark} ${other}`;
    return `${mark} ${other}`;
  }

  function renderStandings() {
    els.standings.replaceChildren();
    ["AFC", "NFC"].forEach((conference) => {
      const label = el("div", "conference-label");
      label.append(el("h2", conference.toLowerCase(), conference));
      const grid = el("div", "division-grid");
      League.DIVISIONS.filter((division) => division.conference === conference).forEach((division) => {
        const panel = el("section", "division");
        panel.append(el("h3", "", division.name));
        ranked(division.teams).forEach((row, index) => {
          const line = el("div", "stand-row");
          line.style.setProperty("--team", League.team(row.abbr).color);
          if (row.abbr === SEA) line.classList.add("is-seattle");
          line.append(el("span", "pos", String(index + 1)));
          line.append(logoImg(row.abbr));
          const name = el("div");
          name.append(el("span", "stand-abbr", row.abbr));
          name.append(el("span", "stand-next", nextLabel(row.abbr)));
          line.append(name);
          line.append(el("span", "stand-rec", row.record.summary || "—"));
          panel.append(line);
        });
        grid.append(panel);
      });
      els.standings.append(label, grid);
    });
  }

  function espnId(abbr) {
    const key = League.norm(abbr);
    const standing = state.records[key];
    return (standing && standing.id) || League.team(key).id;
  }

  function divisionFor(abbr) {
    return League.DIVISIONS.find((division) => division.teams.includes(League.norm(abbr))) || null;
  }

  async function fetchTeamSchedule(abbr, force) {
    const key = League.norm(abbr);
    if (!force && state.teamSchedules.has(key)) return state.teamSchedules.get(key);
    const id = espnId(key);
    if (!id) throw new Error(`No ESPN id for ${key}`);
    const payload = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/schedule?season=${state.seasonYear}`);
    const games = League.parseTeamSchedule(payload, id);
    state.teamSchedules.set(key, games);
    return games;
  }

  function resultFromScores(teamScore, opponentScore) {
    if (teamScore == null || opponentScore == null) return "";
    if (teamScore > opponentScore) return "W";
    if (teamScore < opponentScore) return "L";
    return "T";
  }

  function withLiveScores(games) {
    const board = [...state.cache.values()].flat();
    return games.map((game) => {
      const match = board.find((item) => League.involves(item, game.teamAbbr) && League.involves(item, game.opponentAbbr));
      if (!match || (match.status !== "in" && match.status !== "post")) return game;
      const teamSide = match.home.abbr === game.teamAbbr ? match.home : match.away;
      const opponentSide = match.home.abbr === game.teamAbbr ? match.away : match.home;
      const teamScore = League.numericScore(teamSide.score);
      const opponentScore = League.numericScore(opponentSide.score);
      return {
        ...game,
        status: match.status,
        teamScore: teamScore != null ? teamScore : game.teamScore,
        opponentScore: opponentScore != null ? opponentScore : game.opponentScore,
        clock: match.clock || game.clock,
        period: match.period || game.period,
        result: match.status === "post" ? resultFromScores(teamScore != null ? teamScore : game.teamScore, opponentScore != null ? opponentScore : game.opponentScore) : "",
      };
    });
  }

  function recordFromTeamGames(games) {
    const done = games.filter((game) => game.status === "post" && game.result);
    return League.formatRecord(
      done.filter((game) => game.result === "W").length,
      done.filter((game) => game.result === "L").length,
      done.filter((game) => game.result === "T").length
    );
  }

  function renderTeamDetail() {
    const abbr = state.selectedTeam;
    const info = League.team(abbr);
    const division = divisionFor(abbr);
    const games = withLiveScores(state.teamSchedules.get(abbr) || []);
    const record = games.length ? recordFromTeamGames(games) : recordFor(abbr);
    els.teams.replaceChildren();

    const nav = el("div", "detail-nav");
    if (state.teamFromMatchup && state.selectedGameId) {
      const backMatch = el("button", "back-link", "← Back to matchup");
      backMatch.type = "button";
      backMatch.addEventListener("click", returnToMatchup);
      const allTeams = el("button", "back-link", "All teams");
      allTeams.type = "button";
      allTeams.addEventListener("click", () => {
        state.selectedTeam = null;
        state.teamFromMatchup = false;
        renderTeams();
      });
      nav.append(backMatch, allTeams);
    } else {
      const back = el("button", "back-link", "← All teams");
      back.type = "button";
      back.addEventListener("click", () => {
        state.selectedTeam = null;
        state.teamFromMatchup = false;
        renderTeams();
      });
      nav.append(back);
    }

    const hero = el("header", "team-hero");
    hero.style.setProperty("--team", info.color);
    if (abbr === SEA) hero.classList.add("is-seattle");
    hero.append(logoImg(abbr, "team-hero-logo"));
    const identity = el("div");
    identity.append(el("h2", "", info.name));
    identity.append(el("p", "team-division", division ? division.name : ""));
    identity.append(el("p", "team-record-line", `${state.seasonYear} record: ${record}`));
    hero.append(identity);

    const filters = el("div", "filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filter team schedule");
    [
      ["all", "All games"],
      ["completed", "Completed"],
      ["upcoming", "Upcoming"],
    ].forEach(([value, label]) => {
      const button = el("button", state.teamFilter === value ? "is-selected" : "", label);
      button.type = "button";
      button.setAttribute("aria-pressed", state.teamFilter === value ? "true" : "false");
      button.addEventListener("click", () => {
        state.teamFilter = value;
        renderTeamDetail();
      });
      filters.append(button);
    });

    const list = el("div", "schedule-list");
    const visible = games.filter((game) => {
      if (state.teamFilter === "completed") return game.status === "post";
      if (state.teamFilter === "upcoming") return game.status === "pre";
      return true;
    });
    if (!games.length) {
      list.append(el("p", "empty", "Loading schedule…"));
    } else if (!visible.length) {
      list.append(el("p", "empty", "No games in this view."));
    } else {
      visible.forEach((game) => list.append(teamGameRow(info, game)));
    }

    els.teams.append(nav, hero, filters, list);
    tick();
  }

  function teamGameRow(info, game) {
    const opponent = League.team(game.opponentAbbr);
    const row = el("article", "game-row team-game");
    if (game.status === "in") row.classList.add("is-live");
    const week = el("div", "week-badge");
    week.append(el("span", "", "Wk"), el("strong", "", String(game.week)));
    const details = el("div");
    const place = game.isHome ? "vs" : "@";
    details.append(el("p", "game-name", `${info.short} ${place} ${opponent.short}`));
    const where = game.isHome ? "Home" : "Away";
    details.append(el("p", "game-meta", `${whenLine(game.kickoffMs)} · ${where}${game.venue ? ` · ${game.venue}` : ""}`));

    if (game.status === "pre") {
      const count = el("p", "mini-count", "");
      count.dataset.kickoff = String(game.kickoffMs);
      count.dataset.unit = "all";
      details.append(count);
    } else {
      const scores = el("p", "scoreline");
      const teamWins = game.teamScore != null && game.opponentScore != null && game.teamScore > game.opponentScore;
      const opponentWins = game.teamScore != null && game.opponentScore != null && game.opponentScore > game.teamScore;
      const teamMark = el("span", teamWins ? "is-winner" : "", `${info.abbr} ${game.teamScore == null ? "—" : game.teamScore}`);
      const opponentMark = el("span", opponentWins ? "is-winner" : "", `${opponent.abbr} ${game.opponentScore == null ? "—" : game.opponentScore}`);
      scores.append(teamMark, document.createTextNode(" – "), opponentMark);
      details.append(scores);
      if (game.status === "in" && game.teamScore == null) {
        details.append(el("p", "game-meta", "Live score is not in the team schedule feed yet."));
      }
    }

    const status = el("div", "game-status");
    if (game.status === "in") {
      status.append(el("span", "result-chip live", "Live"));
      status.append(el("span", "clock-detail", liveDetail(game)));
    } else if (game.status === "post") {
      status.append(el("span", "result-chip final", "Final"));
      if (game.result) {
        const mark = el("span", `detail-result ${game.result === "W" ? "win" : game.result === "L" ? "loss" : "tie"}`, game.result);
        status.append(mark);
      }
    } else {
      status.append(el("span", "result-chip upcoming", "Upcoming"));
    }

    row.append(week, logoImg(game.opponentAbbr, "row-logo"), details, status);
    return row;
  }

  async function openTeam(abbr, origin) {
    state.selectedTeam = League.norm(abbr);
    state.teamFromMatchup = origin === "matchup";
    state.teamFilter = "all";
    renderTeamDetail();
    const panel = document.querySelector('[data-panel="teams"]');
    if (panel) panel.scrollIntoView({ block: "start" });
    try {
      await fetchTeamSchedule(state.selectedTeam);
      const games = state.teamSchedules.get(state.selectedTeam) || [];
      const weeks = new Set();
      games.forEach((game) => {
        const started = game.kickoffMs && game.kickoffMs <= Date.now();
        if (game.status === "in" || (game.status === "pre" && started)) weeks.add(game.week || state.currentWeek);
      });
      for (const week of weeks) {
        state.cache.delete(week);
        await fetchWeek(week).catch(() => {});
      }
      if (state.selectedTeam === League.norm(abbr)) renderTeamDetail();
    } catch (error) {
      if (state.selectedTeam === League.norm(abbr) && !(state.teamSchedules.get(state.selectedTeam) || []).length) {
        els.teams.querySelector(".schedule-list").replaceChildren(
          el("p", "empty", "This team's schedule could not be loaded from the ESPN team schedule feed.")
        );
      }
    }
  }

  function renderTeams() {
    if (state.selectedTeam) {
      renderTeamDetail();
      return;
    }
    els.teams.replaceChildren();
    ["AFC", "NFC"].forEach((conference) => {
      const label = el("div", "conference-label");
      label.append(el("h2", conference.toLowerCase(), conference));
      els.teams.append(label);
      League.DIVISIONS.filter((division) => division.conference === conference).forEach((division) => {
        els.teams.append(el("h3", "division-name", division.name));
        const grid = el("div", "team-grid");
        division.teams.forEach((abbr) => {
          const info = League.team(abbr);
          const card = el("button", "team-card");
          card.type = "button";
          card.style.setProperty("--team", info.color);
          card.setAttribute("aria-label", `${info.name} season details`);
          if (abbr === SEA) card.classList.add("is-seattle");
          card.addEventListener("click", () => openTeam(abbr));
          card.append(logoImg(abbr));
          card.append(el("h3", "", info.short));
          card.append(el("p", "record", recordFor(abbr)));
          const game = outlookFor(abbr);
          card.append(el("p", "next", game ? nextLabel(abbr) : "Bye"));
          if (game && game.status === "pre") {
            card.append(el("p", "when", whenLine(game.kickoffMs)));
            const count = el("p", "mini-count", "");
            count.dataset.kickoff = String(game.kickoffMs);
            count.dataset.unit = "all";
            card.append(count);
          } else if (game && game.status === "in") {
            card.append(el("p", "mini-count", "Live"));
          } else if (game) {
            card.append(el("p", "when", "Final"));
          }
          grid.append(card);
        });
        els.teams.append(grid);
      });
    });
  }

  function renderSchedule() {
    const record = Season.recordFromGames(state.games);
    const recordText = record.ties ? `${record.wins}-${record.losses}-${record.ties}` : `${record.wins}-${record.losses}`;
    setText(els.scheduleTitle, `${state.seasonYear}–${state.seasonYear + 1} Seahawks schedule`);
    setText(els.scheduleMeta, `Seattle ${recordText} · ${record.played} of ${record.total || 17} played`);
    const games = state.games.filter((game) => {
      if (state.filter === "upcoming") return !game.isPast;
      if (state.filter === "final") return game.isPast;
      return true;
    });
    els.schedule.replaceChildren();
    if (!games.length) {
      els.schedule.append(el("p", "empty", "No games in this view."));
      return;
    }
    games.forEach((game) => {
      const row = el("article", "game-row");
      if (game.week === state.week) row.classList.add("is-week");
      if (game.isNext) row.classList.add("is-next");
      if (game.isPast) row.classList.add("is-past");
      const week = el("div", "week-badge");
      week.append(el("span", "", "Wk"), el("strong", "", String(game.week)));
      const details = el("div");
      details.append(el("p", "game-name", `${game.isHome ? "vs" : "@"} ${game.opponent}`));
      details.append(el("p", "game-meta", `${Season.formatWeekdayShort(game.kickoffMs)} · ${Season.formatShortDate(game.kickoffMs)} · ${Season.formatKickoff(game.kickoffMs)} · ${game.venue}`));
      const status = el("div", "game-status");
      if (game.result) {
        status.textContent = game.result;
        status.classList.add(game.isWin ? "win" : game.isTie ? "tie" : "loss");
      } else if (game.isNext) {
        status.textContent = "Next";
        status.classList.add("next");
      } else {
        status.textContent = Season.formatKickoff(game.kickoffMs);
      }
      row.append(week, logoImg(game.opponentAbbr, "row-logo"), details, status);
      els.schedule.append(row);
    });
  }

  function saveModel() {
    state.modelStore.updatedAt = new Date().toISOString();
    state.modelStore.season = state.seasonYear;
    writeStore(modelStorageKey(), state.modelStore);
  }

  function savePicks() {
    writeStore(picksStorageKey(), state.picks);
  }

  function stamp(iso) {
    if (!iso) return "not yet";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "not yet";
    return `${Season.formatShortDate(date.getTime())} · ${Season.formatKickoff(date.getTime())}`;
  }

  function teamNames() {
    const names = {};
    Object.keys(League.TEAMS).forEach((abbr) => {
      names[abbr] = League.team(abbr).name;
    });
    return names;
  }

  function inConference(abbr, conference) {
    return League.DIVISIONS.some((division) => division.conference === conference && division.teams.includes(abbr));
  }

  function completedRows() {
    const rows = [];
    state.cache.forEach((games) => {
      games.forEach((game) => {
        if (game.status !== "post" || game.postponed) return;
        const homeScore = League.numericScore(game.home.score);
        const awayScore = League.numericScore(game.away.score);
        if (homeScore == null || awayScore == null) return;
        rows.push({
          week: game.week,
          kickoffMs: game.kickoffMs,
          home: game.home.abbr,
          away: game.away.abbr,
          homeScore,
          awayScore,
        });
      });
    });
    return rows;
  }

  function actualOf(game) {
    if (game.status !== "post" || game.postponed) return null;
    const homeScore = League.numericScore(game.home.score);
    const awayScore = League.numericScore(game.away.score);
    if (homeScore == null || awayScore == null) return null;
    return {
      homeScore,
      awayScore,
      winner: homeScore === awayScore ? "TIE" : homeScore > awayScore ? game.home.abbr : game.away.abbr,
    };
  }

  function currentProfiles() {
    const index = Predict.buildIndex(completedRows());
    return Predict.profilesFor(state.records, index, state.modelStore.turnovers || {});
  }

  function syncCachedGames() {
    const profiles = currentProfiles();
    const names = teamNames();
    const now = new Date().toISOString();
    const before = JSON.stringify(state.modelStore.predictions);
    const picksBefore = JSON.stringify(state.picks);
    state.cache.forEach((games) => {
      games.forEach((game) => {
        const started = game.postponed || game.kickoffMs <= Date.now() || game.status === "in" || game.status === "post";
        const latest = started ? null : Predict.project(game.home.abbr, game.away.abbr, profiles, game.neutral, names);
        Predict.syncPrediction(state.modelStore, {
          id: String(game.id),
          week: game.week || state.week,
          kickoffMs: game.kickoffMs,
          home: game.home.abbr,
          away: game.away.abbr,
          neutral: game.neutral,
          postponed: game.postponed,
        }, latest, started, actualOf(game), now);
      });
    });
    Object.values(state.picks).forEach((pick) => {
      if (!pick.frozen && pick.kickoffMs && pick.kickoffMs <= Date.now()) {
        pick.frozen = true;
        pick.frozenAt = now;
      }
    });
    if (before !== JSON.stringify(state.modelStore.predictions)) saveModel();
    if (picksBefore !== JSON.stringify(state.picks)) savePicks();
    return profiles;
  }

  function turnoversFresh() {
    const at = Date.parse(state.modelStore.turnoversAt || "");
    return Number.isFinite(at) && Date.now() - at < 30 * 60 * 1000 && Object.keys(state.modelStore.turnovers || {}).length >= 30;
  }

  async function fetchMissingWeeks(token) {
    const missing = [];
    for (let week = 1; week <= LAST_WEEK; week += 1) {
      if (!state.cache.has(week)) missing.push(week);
    }
    let cursor = 0;
    async function worker() {
      while (cursor < missing.length) {
        const week = missing[cursor];
        cursor += 1;
        if (token !== state.modelToken) return;
        await fetchWeek(week).catch(() => {});
      }
    }
    await Promise.all([worker(), worker(), worker()]);
  }

  async function fetchTurnovers(token) {
    if (turnoversFresh()) return;
    const abbrs = Object.keys(League.TEAMS);
    let cursor = 0;
    const found = {};
    async function worker() {
      while (cursor < abbrs.length) {
        const abbr = abbrs[cursor];
        cursor += 1;
        if (token !== state.modelToken) return;
        try {
          const payload = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${League.team(abbr).id}/statistics`);
          found[abbr] = Predict.readTurnover(payload);
        } catch (error) {
          found[abbr] = null;
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (token !== state.modelToken) return;
    state.modelStore.turnovers = found;
    state.modelStore.turnoversAt = new Date().toISOString();
  }

  function ensureModel() {
    const token = ++state.modelToken;
    state.modelReady = false;
    state.projLoading = "Loading schedules and team statistics…";
    return (async () => {
      try {
        const fileStore = await fetchJson(`data/predictions/${state.seasonYear}.json`).catch(() => null);
        if (token !== state.modelToken) return;
        state.modelStore = Predict.mergeStores(fileStore, readStore(modelStorageKey()) || state.modelStore);
        await fetchMissingWeeks(token);
        if (token !== state.modelToken) return;
        await fetchTurnovers(token);
        if (token !== state.modelToken) return;
        state.modelReady = true;
        state.projLoading = "";
        syncCachedGames();
        if (state.view === "projections") renderProjections();
      } catch (error) {
        if (token === state.modelToken) state.projLoading = "";
      }
    })();
  }

  function ensureConference(conference) {
    if (state.conferenceTried[conference]) return;
    state.conferenceTried[conference] = true;
    const teams = League.DIVISIONS.filter((division) => division.conference === conference).flatMap((division) => division.teams);
    const missing = teams.filter((abbr) => !state.teamSchedules.has(abbr));
    if (!missing.length) return;
    state.projLoading = `Loading ${conference} schedules for division and playoff odds…`;
    Promise.all(missing.map((abbr) => fetchTeamSchedule(abbr).catch(() => []))).then(() => {
      state.projLoading = "";
      if (state.view === "projections") renderProjections();
    });
  }

  function typingProjection() {
    return Boolean(els.projections && document.activeElement && document.activeElement.tagName === "INPUT" && els.projections.contains(document.activeElement));
  }

  function rememberSnapshot(abbr, values) {
    const week = String(state.currentWeek || state.week);
    const snapshots = state.modelStore.snapshots || (state.modelStore.snapshots = {});
    const bucket = snapshots[week] || (snapshots[week] = { savedAt: new Date().toISOString(), teams: {} });
    if (bucket.teams[abbr]) return;
    bucket.teams[abbr] = values;
    saveModel();
  }

  function choiceButton(label, value, selected) {
    const button = el("button", selected ? "is-selected" : "", label);
    button.type = "button";
    button.dataset.choice = value;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    button.addEventListener("click", () => {
      button.parentElement.querySelectorAll("[data-choice]").forEach((item) => {
        const on = item === button;
        item.classList.toggle("is-selected", on);
        item.setAttribute("aria-pressed", on ? "true" : "false");
      });
    });
    return button;
  }

  function predictionCard(game, profiles) {
    const id = String(game.id);
    const prediction = state.modelStore.predictions[id];
    const home = League.team(game.home.abbr);
    const away = League.team(game.away.abbr);
    const card = el("article", "game-card proj-card");
    card.style.setProperty("--away", away.color);
    card.style.setProperty("--home", home.color);
    if (League.involves(game, SEA)) card.classList.add("is-seattle");
    if (game.status === "in") card.classList.add("is-live");
    const editable = !game.postponed && game.status === "pre" && game.kickoffMs > Date.now();
    if (editable) card.dataset.kickoffLock = String(game.kickoffMs);
    card.append(el("p", "card-when", `Week ${game.week || state.week} · ${whenLine(game.kickoffMs)}${game.neutral ? " · Neutral site" : ""}`));

    const sides = el("div", "proj-sides");
    [game.away, game.home].forEach((side, index) => {
      const info = League.team(side.abbr);
      const column = el("div");
      column.append(logoImg(side.abbr));
      column.append(el("h3", "", info.name));
      column.append(el("p", "abbr", info.abbr));
      column.append(el("p", "record", recordFor(side.abbr, side.record)));
      column.append(el("span", "place-chip", index === 0 ? "Away" : "Home"));
      sides.append(column);
      if (index === 0) sides.append(el("div", "versus", "VS"));
    });
    card.append(sides);

    if (game.postponed) {
      card.append(el("p", "proj-explain", "This game is postponed. It is not graded and it is left out of the remaining-season simulation."));
      return card;
    }

    if (!prediction || prediction.missing) {
      card.append(el("p", "proj-explain", "No prediction was saved before kickoff. This game is not given a backfilled pick."));
    } else {
      const winnerName = prediction.winner === "TIE" ? "Tie" : League.team(prediction.winner).name;
      card.append(el("p", "form-line", `Predicted winner · ${winnerName}`));
      const scores = el("p", "scoreline");
      const homeWins = prediction.homeScore > prediction.awayScore;
      const awayWins = prediction.awayScore > prediction.homeScore;
      scores.append(
        el("span", awayWins ? "is-winner" : "", `${away.abbr} ${prediction.awayScore}`),
        document.createTextNode(" – "),
        el("span", homeWins ? "is-winner" : "", `${home.abbr} ${prediction.homeScore}`)
      );
      card.append(scores);
      const bar = el("div", "prob-bar");
      const awayShare = el("span");
      awayShare.style.width = `${Math.round(prediction.awayWinProb * 100)}%`;
      awayShare.style.background = away.color;
      const homeShare = el("span");
      homeShare.style.width = `${Math.round(prediction.homeWinProb * 100)}%`;
      homeShare.style.background = home.color;
      bar.append(awayShare, homeShare);
      card.append(bar);
      const labels = el("div", "prob-labels");
      labels.append(
        el("span", "", `${away.abbr} ${Math.round(prediction.awayWinProb * 100)}%`),
        el("span", "", `${home.abbr} ${Math.round(prediction.homeWinProb * 100)}%`)
      );
      card.append(labels);
      card.append(el("p", "form-line", `Confidence · ${prediction.confidence}`));
      card.append(el("p", "proj-explain", prediction.explanation));
      const homeForm = (prediction.recentHome || []).join(" ") || "none yet";
      const awayForm = (prediction.recentAway || []).join(" ") || "none yet";
      card.append(el("p", "form-line", `Last 5 · ${away.abbr} ${awayForm} · ${home.abbr} ${homeForm}`));
      card.append(el("p", "proj-note", prediction.frozen ? "Frozen at kickoff." : "This projection can still change before kickoff."));
    }

    if (game.status === "in") {
      card.append(el("p", "form-line", `Live · ${away.abbr} ${scoreText(game.away.score)} – ${home.abbr} ${scoreText(game.home.score)} · ${liveDetail(game)}`));
    } else if (game.status === "post") {
      const actual = actualOf(game);
      if (actual) {
        card.append(el("p", "form-line", `Final · ${away.abbr} ${actual.awayScore} – ${home.abbr} ${actual.homeScore}`));
        if (prediction && !prediction.missing) {
          card.append(el("p", "proj-explain", `Model ${prediction.winner === actual.winner ? "correct" : "incorrect"}. Predicted ${prediction.awayScore}-${prediction.homeScore}, actual ${actual.awayScore}-${actual.homeScore}.`));
        }
      }
    }

    return card;
  }

  function readPickScore(input) {
    if (!input.value.trim()) return null;
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < 0 || value > 99) return undefined;
    return value;
  }

  function metric(label, value, kind) {
    const box = el("div");
    box.append(el("span", kind || "", label), el("strong", "", value));
    return box;
  }

  function divisionDashboard(name, profiles) {
    const division = League.DIVISIONS.find((item) => item.name === name);
    const wrap = el("section");
    wrap.append(el("h3", "division-name", `${name} · actual standings and model projections`));
    if (!division) return wrap;
    const conference = division.conference;
    const schedulesReady = League.DIVISIONS.filter((item) => item.conference === conference).every((item) => item.teams.every((abbr) => state.teamSchedules.has(abbr)));
    if (!schedulesReady) ensureConference(conference);
    const conferenceTeams = League.DIVISIONS.filter((item) => item.conference === conference).flatMap((item) => item.teams);
    const remaining = [];
    const seen = new Set();
    if (schedulesReady) {
      conferenceTeams.forEach((abbr) => {
        (state.teamSchedules.get(abbr) || []).forEach((game) => {
          if (game.postponed || game.status !== "pre" || game.kickoffMs <= Date.now() || !game.id || seen.has(game.id)) return;
          seen.add(game.id);
          remaining.push({
            id: game.id,
            neutral: false,
            home: game.isHome ? game.teamAbbr : game.opponentAbbr,
            away: game.isHome ? game.opponentAbbr : game.teamAbbr,
          });
        });
      });
    }
    const odds = schedulesReady ? Predict.playoffOdds(conference, League.DIVISIONS, remaining, state.records, profiles) : null;
    const weekGames = state.cache.get(state.week) || [];
    const rankedTeams = division.teams.slice().sort((a, b) => {
      const left = state.records[a] || { wins: 0, losses: 0, diff: 0 };
      const right = state.records[b] || { wins: 0, losses: 0, diff: 0 };
      return right.wins - left.wins || left.losses - right.losses || (right.diff || 0) - (left.diff || 0);
    });
    rankedTeams.forEach((abbr, index) => {
      const info = League.team(abbr);
      const record = state.records[abbr] || {};
      const profile = profiles[abbr];
      const card = el("article", "proj-team");
      if (abbr === SEA) card.classList.add("is-seattle");
      const head = el("div", "proj-team-head");
      head.append(logoImg(abbr));
      const title = el("div");
      title.append(el("h3", "", `${index + 1}. ${info.name}`));
      title.append(el("p", "proj-note", "Actual standing"));
      head.append(title);
      card.append(head);
      const metrics = el("div", "proj-metrics");
      metrics.append(metric("Actual record", record.summary || "—", "actual-tag"));
      metrics.append(metric("Division record", record.divisionRecord || "—", "actual-tag"));
      metrics.append(metric("Points for / game", profile && profile.ppg != null ? profile.ppg.toFixed(1) : "—", "actual-tag"));
      metrics.append(metric("Points allowed / game", profile && profile.papg != null ? profile.papg.toFixed(1) : "—", "actual-tag"));
      metrics.append(metric("Last 5", profile && profile.recent.length ? profile.recent.join(" ") : "—", "actual-tag"));
      metrics.append(metric("Current seed", record.playoffSeed || "—", "actual-tag"));
      const teamRemaining = remaining.filter((game) => game.home === abbr || game.away === abbr);
      const expected = schedulesReady && profile && profile.ready ? Predict.expectedRemaining(abbr, teamRemaining, profiles) : null;
      const projectedWins = expected == null ? null : (record.wins || 0) + expected;
      metrics.append(metric("Projected remaining wins", expected == null ? "—" : expected.toFixed(1), "model-tag"));
      metrics.append(metric("Projected final wins", projectedWins == null ? "—" : projectedWins.toFixed(1), "model-tag"));
      metrics.append(metric("Division chance", odds ? `${Math.round(odds[abbr].division * 100)}%` : "—", "model-tag"));
      metrics.append(metric("Playoff chance", odds ? `${Math.round(odds[abbr].playoff * 100)}%` : "—", "model-tag"));
      card.append(metrics);
      const played = weekGames.some((game) => League.involves(game, abbr));
      if (!played) card.append(el("p", "form-line", `Bye in week ${state.week}`));
      const history = snapshotSeries(abbr);
      if (history.length) {
        card.append(el("p", "proj-note", `Saved projected wins by week: ${history.map((item) => `Wk ${item.week} ${item.projectedWins.toFixed(1)}`).join(" · ")}`));
      }
      wrap.append(card);
      if (odds && projectedWins != null) {
        rememberSnapshot(abbr, {
          projectedWins,
          divisionOdds: odds[abbr].division,
          playoffOdds: odds[abbr].playoff,
        });
      }
    });
    if (!schedulesReady) wrap.append(el("p", "proj-loading", state.projLoading || "Loading remaining schedules…"));
    return wrap;
  }

  function snapshotSeries(abbr) {
    return Object.keys(state.modelStore.snapshots || {}).sort((a, b) => Number(a) - Number(b)).map((week) => {
      const row = state.modelStore.snapshots[week].teams[abbr];
      return row ? { week, projectedWins: row.projectedWins } : null;
    }).filter(Boolean);
  }

  function accuracyChart(points) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 360 120");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Model accuracy by week");
    svg.classList.add("accuracy-chart");
    if (points.length < 2) return null;
    const coords = points.map((point, index) => {
      const x = 16 + (index / (points.length - 1)) * 328;
      const y = 104 - point.pct * 88;
      return `${x},${y}`;
    });
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#f3e6c4");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("points", coords.join(" "));
    svg.append(line);
    return svg;
  }

  function accuracyPanel() {
    const wrap = el("section");
    const weeks = {};
    for (let week = 1; week <= LAST_WEEK; week += 1) {
      weeks[week] = { modelCorrect: 0, modelTotal: 0, mineCorrect: 0, mineTotal: 0 };
    }
    const divisions = {};
    League.DIVISIONS.forEach((division) => {
      divisions[division.name] = { correct: 0, total: 0 };
    });
    let missing = 0;
    const history = [];
    Object.values(state.modelStore.predictions).forEach((prediction) => {
      if (prediction.missing && prediction.actual) missing += 1;
      if (!Predict.graded(prediction)) return;
      const week = weeks[prediction.week] || weeks[1];
      week.modelTotal += 1;
      if (Predict.correct(prediction)) week.modelCorrect += 1;
      [prediction.home, prediction.away].forEach((abbr) => {
        const division = divisionFor(abbr);
        if (!division) return;
        divisions[division.name].total += 1;
        if (Predict.correct(prediction)) divisions[division.name].correct += 1;
      });
      const pick = state.picks[prediction.id];
      if (pick && pick.winner && pick.savedAt && Date.parse(pick.savedAt) <= prediction.kickoffMs) {
        week.mineTotal += 1;
        if (pick.winner === prediction.actual.winner) week.mineCorrect += 1;
      }
      history.push(prediction);
    });
    const modelTotal = Object.values(weeks).reduce((sum, week) => sum + week.modelTotal, 0);
    const modelCorrect = Object.values(weeks).reduce((sum, week) => sum + week.modelCorrect, 0);
    const mineTotal = Object.values(weeks).reduce((sum, week) => sum + week.mineTotal, 0);
    const mineCorrect = Object.values(weeks).reduce((sum, week) => sum + week.mineCorrect, 0);
    const summary = el("div", "proj-metrics");
    summary.append(metric("Graded predictions", String(modelTotal), "actual-tag"));
    summary.append(metric("Model correct", modelTotal ? `${modelCorrect} · ${Math.round((modelCorrect / modelTotal) * 100)}%` : "—", "model-tag"));
    summary.append(metric("Your correct", mineTotal ? `${mineCorrect} · ${Math.round((mineCorrect / mineTotal) * 100)}%` : "—", "model-tag"));
    summary.append(metric("Finals with no saved prediction", String(missing), "actual-tag"));
    wrap.append(summary);
    let runningCorrect = 0;
    let runningTotal = 0;
    const points = [];
    const table = el("div");
    for (let week = 1; week <= LAST_WEEK; week += 1) {
      const row = weeks[week];
      if (!row.modelTotal && !row.mineTotal) continue;
      runningCorrect += row.modelCorrect;
      runningTotal += row.modelTotal;
      if (row.modelTotal) points.push({ week, pct: runningCorrect / runningTotal });
      table.append(el("p", "history-row", `Week ${week}: model ${row.modelCorrect}/${row.modelTotal || 0}, you ${row.mineCorrect}/${row.mineTotal || 0}`));
    }
    const chart = accuracyChart(points);
    if (chart) wrap.append(chart);
    else wrap.append(el("p", "proj-note", "The accuracy line will appear after predicted games in at least two weeks become final."));
    wrap.append(table);
    wrap.append(el("h3", "division-name", "Accuracy by division"));
    wrap.append(el("p", "proj-note", "A game counts for the division of each team in it."));
    League.DIVISIONS.forEach((division) => {
      const bucket = divisions[division.name];
      const text = bucket.total ? `${bucket.correct}/${bucket.total} · ${Math.round((bucket.correct / bucket.total) * 100)}%` : "No graded games";
      wrap.append(el("p", "history-row", `${division.name}: ${text}`));
    });
    wrap.append(el("h3", "division-name", "Prediction history"));
    history.sort((a, b) => a.kickoffMs - b.kickoffMs);
    if (!history.length) wrap.append(el("p", "proj-note", "Finished games that were predicted before kickoff will be listed here."));
    history.forEach((prediction) => {
      const pick = state.picks[prediction.id];
      const yours = pick && pick.winner ? (pick.winner === "TIE" ? "Tie" : pick.winner) : "no pick";
      wrap.append(el("p", "history-row", `Week ${prediction.week}: predicted ${prediction.away} ${prediction.awayScore}–${prediction.home} ${prediction.homeScore}, actual ${prediction.actual.awayScore}–${prediction.actual.homeScore}, model ${prediction.winner === prediction.actual.winner ? "correct" : "incorrect"}, you ${yours}`));
    });
    return wrap;
  }

  function viewGames() {
    return (state.cache.get(state.week) || []).filter((game) => {
      if (state.projView === "afc" || state.projView === "nfc") {
        const conference = state.projView.toUpperCase();
        if (!inConference(game.home.abbr, conference) && !inConference(game.away.abbr, conference)) return false;
        if (state.projDivision) {
          const division = League.DIVISIONS.find((item) => item.name === state.projDivision);
          if (division && !division.teams.includes(game.home.abbr) && !division.teams.includes(game.away.abbr)) return false;
        }
      }
      return true;
    });
  }

  function projectionFilters() {
    const bar = el("div", "filters proj-filters");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Projection sections");
    [
      ["all", "All NFL games"],
      ["afc", "AFC"],
      ["nfc", "NFC"],
    ].forEach(([value, label]) => {
      const button = el("button", state.projView === value ? "is-selected" : "", label);
      button.type = "button";
      button.setAttribute("aria-pressed", state.projView === value ? "true" : "false");
      button.addEventListener("click", () => {
        state.projView = value;
        if (value !== "afc" && value !== "nfc") state.projDivision = "";
        renderProjections(true);
      });
      bar.append(button);
    });
    return bar;
  }

  function divisionFilters(conference) {
    const bar = el("div", "filters proj-filters");
    const selectedAll = state.projDivision === "";
    const all = el("button", selectedAll ? "is-selected" : "", `All ${conference}`);
    all.type = "button";
    all.addEventListener("click", () => {
      state.projDivision = "";
      renderProjections(true);
    });
    bar.append(all);
    League.DIVISIONS.filter((division) => division.conference === conference).forEach((division) => {
      const button = el("button", state.projDivision === division.name ? "is-selected" : "", division.name.replace(`${conference} `, ""));
      button.type = "button";
      button.addEventListener("click", () => {
        state.projDivision = division.name;
        renderProjections(true);
      });
      bar.append(button);
    });
    return bar;
  }

  function renderProjections(force) {
    if (!els.projections) return;
    if (!state.modelCheck) state.modelCheck = Predict.selfCheck();
    if (state.modelCheck.ok) syncCachedGames();
    if (state.view !== "projections" && !force) return;
    if (!force && typingProjection()) return;
    const profiles = state.modelCheck.ok ? currentProfiles() : null;
    setText(els.projectionsMeta, `Scores refreshed ${stamp(state.dataUpdatedAt)}. Predictions saved ${stamp(state.modelStore.updatedAt)}.`);
    els.projections.replaceChildren();
    if (!state.modelCheck.ok) {
      els.projections.append(el("p", "pick-error", "The prediction check failed, so no scores were generated."));
      return;
    }
    renderRoadTile();
    els.projections.append(projectionFilters());
    if (state.projView === "bracket") return;
    if (state.projLoading) els.projections.append(el("p", "proj-loading", state.projLoading));
    els.projections.append(el("p", "proj-note", "The week control above chooses the slate. Upcoming projections update when completed games change the statistics. A prediction freezes at kickoff. Games that already started before a prediction was saved stay blank. ESPN lists injuries without a point value, so injuries are not in the score. Gold numbers are model projections. White numbers are actual results."));
    if (state.projView === "afc" || state.projView === "nfc") {
      const conference = state.projView.toUpperCase();
      els.projections.append(divisionFilters(conference));
      if (state.projDivision) els.projections.append(divisionDashboard(state.projDivision, profiles));
    }
    const games = viewGames();
    if (!games.length) {
      els.projections.append(el("p", "empty", state.modelReady ? "No games in this view." : "Loading the weekly schedule…"));
      return;
    }
    games.forEach((game) => {
      els.projections.append(predictionCard(game, profiles));
    });
  }

  function pctLabel(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
  }

  function deltaLabel(current, previous) {
    if (!Number.isFinite(previous)) return "No earlier week is saved yet";
    const diff = Math.round((current - previous) * 1000) / 10;
    if (diff === 0) return "0 since the previous week";
    return `${diff > 0 ? "+" : ""}${diff} since the previous week`;
  }

  function round4(value) {
    return Math.round(value * 10000) / 10000;
  }

  function chartRandom(signature) {
    let seed = 2166136261;
    const text = String(signature || "");
    for (let index = 0; index < text.length; index += 1) seed = Math.imul(seed ^ text.charCodeAt(index), 16777619);
    return function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function roadFinalsKey() {
    return completedRows().map((game) => `${game.home}${game.away}${game.homeScore}${game.awayScore}`).join("|");
  }

  function priorWeekRoad(abbr) {
    const history = (state.modelStore && state.modelStore.roadHistory) || [];
    const week = Number(state.currentWeek || state.week);
    const earlier = history.filter((entry) => Number(entry.week) < week);
    const entry = earlier[earlier.length - 1];
    return entry && entry.teams ? entry.teams[abbr] : null;
  }

  function recordText(abbr) {
    const record = (state.roadRecords && state.roadRecords[abbr]) || state.records[abbr] || {};
    if (record.summary) return record.summary;
    return League.formatRecord(record.wins || 0, record.losses || 0, record.ties || 0);
  }

  function simulationRecords(completed) {
    const records = {};
    Object.keys(League.TEAMS).forEach((abbr) => {
      const standing = state.records[abbr] || {};
      records[abbr] = {
        ...standing,
        wins: 0,
        losses: 0,
        ties: 0,
        divisionWins: 0,
        divisionLosses: 0,
        divisionTies: 0,
        conferenceWins: 0,
        conferenceLosses: 0,
        conferenceTies: 0,
      };
    });
    completed.forEach((game) => {
      const homeDivision = divisionFor(game.home);
      const awayDivision = divisionFor(game.away);
      const divisionGame = homeDivision && awayDivision && homeDivision.name === awayDivision.name;
      const conferenceGame = homeDivision && awayDivision && homeDivision.conference === awayDivision.conference;
      if (game.winner === "TIE") {
        [game.home, game.away].forEach((abbr) => {
          if (!records[abbr]) return;
          records[abbr].ties += 1;
          if (divisionGame) records[abbr].divisionTies += 1;
          if (conferenceGame) records[abbr].conferenceTies += 1;
        });
        return;
      }
      const loser = game.winner === game.home ? game.away : game.home;
      if (!records[game.winner] || !records[loser]) return;
      records[game.winner].wins += 1;
      records[loser].losses += 1;
      if (divisionGame) {
        records[game.winner].divisionWins += 1;
        records[loser].divisionLosses += 1;
      }
      if (conferenceGame) {
        records[game.winner].conferenceWins += 1;
        records[loser].conferenceLosses += 1;
      }
    });
    Object.keys(records).forEach((abbr) => {
      const row = records[abbr];
      const standing = state.records[abbr] || {};
      const played = row.wins + row.losses + row.ties;
      const official = (standing.wins || 0) + (standing.losses || 0) + (standing.ties || 0);
      if (official > played + 1) {
        row.wins = standing.wins || 0;
        row.losses = standing.losses || 0;
        row.ties = standing.ties || 0;
        row.divisionRecord = standing.divisionRecord || "0-0";
        row.conferenceRecord = standing.conferenceRecord || "0-0";
      } else {
        row.divisionRecord = League.formatRecord(row.divisionWins, row.divisionLosses, row.divisionTies);
        row.conferenceRecord = League.formatRecord(row.conferenceWins, row.conferenceLosses, row.conferenceTies);
      }
      row.summary = League.formatRecord(row.wins, row.losses, row.ties);
    });
    return records;
  }

  function standingPlace(abbr) {
    const division = divisionFor(abbr);
    if (!division) return "Division standing unavailable";
    const ordered = division.teams.slice().sort((a, b) => {
      const left = (state.roadRecords && state.roadRecords[a]) || state.records[a] || {};
      const right = (state.roadRecords && state.roadRecords[b]) || state.records[b] || {};
      return (right.wins || 0) - (left.wins || 0) || (left.losses || 0) - (right.losses || 0) || (right.diff || 0) - (left.diff || 0);
    });
    const names = ["1st", "2nd", "3rd", "4th"];
    return `${names[ordered.indexOf(abbr)] || "—"} in the ${division.name}`;
  }

  function collectRemaining() {
    const seen = new Set();
    const finals = new Set(completedRows().map((game) => [game.home, game.away].sort().join("-")));
    const board = [...state.cache.values()].flat();
    const games = [];
    state.teamSchedules.forEach((list) => {
      list.forEach((game) => {
        if (!game.id || seen.has(game.id) || game.postponed || game.status === "post") return;
        const home = League.norm(game.isHome ? game.teamAbbr : game.opponentAbbr);
        const away = League.norm(game.isHome ? game.opponentAbbr : game.teamAbbr);
        if (!League.TEAMS[home] || !League.TEAMS[away]) return;
        if (finals.has([home, away].sort().join("-"))) return;
        seen.add(game.id);
        const match = board.find((item) => League.involves(item, home) && League.involves(item, away));
        games.push({ home, away, neutral: Boolean(match && match.neutral) });
      });
    });
    return games;
  }

  function isEliminated(abbr, remaining) {
    const division = divisionFor(abbr);
    const record = (state.roadRecords && state.roadRecords[abbr]) || state.records[abbr];
    if (!division || !record) return false;
    const left = remaining.filter((game) => game.home === abbr || game.away === abbr).length;
    const maxWins = (record.wins || 0) + left;
    const others = League.DIVISIONS
      .filter((item) => item.conference === division.conference)
      .flatMap((item) => item.teams)
      .filter((team) => team !== abbr)
      .map((team) => ((state.roadRecords && state.roadRecords[team]) || state.records[team] || {}).wins || 0)
      .sort((a, b) => b - a);
    return maxWins < (others[6] || 0);
  }

  function rememberRoad(result) {
    const history = state.modelStore.roadHistory || (state.modelStore.roadHistory = []);
    const finals = completedRows().length;
    const week = state.currentWeek || state.week;
    const last = history[history.length - 1];
    if (last && last.finals === finals && Number(last.week) === Number(week)) return;
    const teams = {};
    Object.keys(result.teams).forEach((abbr) => {
      const row = result.teams[abbr];
      teams[abbr] = {
        division: round4(row.division),
        playoff: round4(row.playoff),
        conference: round4(row.conference),
        superBowl: round4(row.superBowl),
        champion: round4(row.champion),
        seed: row.seed || 0,
        projectedWins: Math.round(row.projectedWins * 10) / 10,
      };
    });
    history.push({ week, finals, savedAt: new Date().toISOString(), teams });
    if (history.length > 40) history.splice(0, history.length - 40);
    saveModel();
  }

  function roadMetaText() {
    const status = state.roadLoading ? "Updating the simulations. " : "";
    return `${status}Scores refreshed ${stamp(state.dataUpdatedAt)}. Projections saved ${stamp(state.modelStore && state.modelStore.updatedAt)}. ${Predict.SIMS.toLocaleString()} simulations. In-progress games are not counted until they are final.`;
  }

  function roadTeamClass(abbr) {
    const classes = ["road-team"];
    const row = state.roadResult && state.roadResult.teams[abbr];
    const prior = priorWeekRoad(abbr);
    if (state.roadTeam === abbr) classes.push("is-selected");
    if (row && row.eliminated) classes.push("is-out");
    if (state.roadDivision && divisionFor(abbr) && divisionFor(abbr).name !== state.roadDivision) classes.push("is-dim");
    if (row && prior && row.champion > prior.champion + 0.0005) classes.push("is-up");
    return classes.join(" ");
  }

  function roadClub(abbr, className) {
    const button = el("button", className || roadTeamClass(abbr));
    button.type = "button";
    button.dataset.roadTeam = abbr;
    button.append(logoImg(abbr));
    button.append(el("span", "", abbr));
    const row = state.roadResult && state.roadResult.teams[abbr];
    button.append(el("strong", "", row ? pctLabel(row.champion) : "—"));
    return button;
  }

  function favoriteClub(conference, field) {
    const clubs = League.DIVISIONS.filter((division) => !conference || division.conference === conference).flatMap((division) => division.teams);
    return clubs.slice().sort((a, b) => state.roadResult.teams[b][field] - state.roadResult.teams[a][field])[0];
  }

  function standingsSeeds(conference) {
    const clubs = League.DIVISIONS.filter((division) => division.conference === conference).flatMap((division) => division.teams);
    return clubs.slice().sort((a, b) => {
      const left = Number.parseInt((state.records[a] || {}).playoffSeed, 10);
      const right = Number.parseInt((state.records[b] || {}).playoffSeed, 10);
      const leftOk = Number.isFinite(left) && left > 0;
      const rightOk = Number.isFinite(right) && right > 0;
      if (leftOk && rightOk && left !== right) return left - right;
      if (leftOk !== rightOk) return leftOk ? -1 : 1;
      return ((state.records[b] || {}).winPercent || 0) - ((state.records[a] || {}).winPercent || 0);
    }).slice(0, 7);
  }

  function projectedSeeds(conference) {
    if (!state.roadResult) return standingsSeeds(conference);
    const seeded = state.roadResult.brackets && state.roadResult.brackets[conference];
    if (seeded && seeded.length === 7 && seeded.every((abbr) => state.roadResult.teams[abbr])) return seeded;
    const clubs = League.DIVISIONS.filter((division) => division.conference === conference).flatMap((division) => division.teams);
    const taken = new Set();
    const seeds = [];
    for (let number = 1; number <= 7; number += 1) {
      const ranked = clubs.slice().sort((a, b) => {
        const left = state.roadResult.teams[a].seedCounts[number - 1] || 0;
        const right = state.roadResult.teams[b].seedCounts[number - 1] || 0;
        return right - left || state.roadResult.teams[b].playoff - state.roadResult.teams[a].playoff;
      });
      const pick = ranked.find((abbr) => !taken.has(abbr));
      taken.add(pick);
      seeds.push(pick);
    }
    return seeds;
  }

  function roadDetail(abbr) {
    const row = state.roadResult.teams[abbr];
    const prior = priorWeekRoad(abbr);
    const card = el("article", "road-detail");
    card.append(logoImg(abbr));
    const copy = el("div");
    copy.append(el("strong", "", `${League.team(abbr).name} · ${recordText(abbr)} · ${standingPlace(abbr)}`));
    if (row.eliminated) copy.append(el("p", "road-note", "Eliminated. Seven conference teams already have more wins than this team can reach."));
    const metrics = el("div", "road-metrics");
    [
      ["Projected record", `${row.projectedWins.toFixed(1)}-${row.projectedLosses.toFixed(1)}`],
      ["Win division", pctLabel(row.division)],
      ["Make playoffs", pctLabel(row.playoff)],
      ["Conference championship", pctLabel(row.conference)],
      ["Reach Super Bowl", pctLabel(row.superBowl)],
      ["Win Super Bowl", pctLabel(row.champion)],
      ["Since previous week", deltaLabel(row.champion, prior && prior.champion)],
      ["Most common seed", row.seed ? `No. ${row.seed}` : "Outside the field"],
    ].forEach(([label, value]) => {
      const item = el("div");
      item.append(el("span", "", label));
      const strong = el("strong", prior && row.champion > prior.champion + 0.0005 && label === "Win Super Bowl" ? "is-up" : "", value);
      item.append(strong);
      metrics.append(item);
    });
    copy.append(metrics);
    card.append(copy);
    return card;
  }

  function conferenceColumn(conference) {
    const section = el("section", `road-conf is-${conference.toLowerCase()}`);
    section.dataset.conf = conference;
    if (state.roadConference !== "all" && state.roadConference !== conference) section.hidden = true;
    section.append(el("h3", "", conference));
    const funnel = el("div", "road-funnel");
    const divisions = el("div");
    divisions.dataset.stage = "divisions";
    League.DIVISIONS.filter((division) => division.conference === conference).forEach((division) => {
      const block = el("div");
      block.append(el("p", "road-division-name", division.name));
      const clubs = el("div", "road-clubs");
      division.teams.forEach((abbr) => clubs.append(roadClub(abbr)));
      block.append(clubs);
      divisions.append(block);
    });
    const field = el("div");
    field.dataset.playoff = conference;
    field.append(el("p", "road-seed-label", "Playoff field"));
    projectedSeeds(conference).forEach((abbr, index) => {
      field.append(el("p", "road-seed-label", index === 0 ? "No. 1 · bye" : `No. ${index + 1}`));
      field.append(roadClub(abbr, roadTeamClass(abbr).replace("road-team", "road-slot")));
    });
    const champ = el("div", "road-champ");
    champ.dataset.champ = conference;
    const leader = favoriteClub(conference, "superBowl");
    champ.append(el("span", "road-seed-label", `${conference} champion`));
    champ.append(logoImg(leader));
    champ.append(el("strong", "", pctLabel(state.roadResult.teams[leader].superBowl)));
    champ.append(el("span", "", leader));
    funnel.append(divisions, field, champ);
    section.append(funnel);
    return section;
  }

  function officialRounds() {
    const map = {};
    (state.officialGames || []).forEach((round) => {
      map[round.name] = round.games || [];
    });
    return map;
  }

  function gameAbbrs(game) {
    return [League.norm(game.home.abbr), League.norm(game.away.abbr)];
  }

  function gameInConference(game, conference) {
    return gameAbbrs(game).some((abbr) => {
      const division = divisionFor(abbr);
      return division && division.conference === conference;
    });
  }

  function gameWinner(game) {
    if (!game || game.status !== "post") return null;
    const homeScore = League.numericScore(game.home.score);
    const awayScore = League.numericScore(game.away.score);
    if (homeScore == null || awayScore == null || homeScore === awayScore) return null;
    const home = League.norm(game.home.abbr);
    const away = League.norm(game.away.abbr);
    return homeScore > awayScore
      ? { abbr: home, score: homeScore, loser: away }
      : { abbr: away, score: awayScore, loser: home };
  }

  function matchupGame(games, left, right) {
    return (games || []).find((game) => {
      const [home, away] = gameAbbrs(game);
      return (home === left && away === right) || (home === right && away === left);
    }) || null;
  }

  function sidePlan(conference) {
    const seeds = projectedSeeds(conference);
    const rounds = officialRounds();
    const wildCard = (rounds["Wild Card"] || []).filter((game) => gameInConference(game, conference));
    const divisional = (rounds.Divisional || []).filter((game) => gameInConference(game, conference));
    const title = (rounds["Conference championship"] || []).filter((game) => gameInConference(game, conference));
    const pairs = [
      matchupGame(wildCard, seeds[1], seeds[6]),
      matchupGame(wildCard, seeds[2], seeds[5]),
      matchupGame(wildCard, seeds[3], seeds[4]),
    ];
    const topDivisional = divisional.find((game) => gameAbbrs(game).includes(seeds[0])) || null;
    const otherDivisional = divisional.find((game) => game !== topDivisional) || null;
    return {
      seeds,
      pairs,
      wildWinners: pairs.map((game) => gameWinner(game)),
      topWinner: gameWinner(topDivisional),
      otherWinner: gameWinner(otherDivisional),
      champ: gameWinner(title[0]),
    };
  }

  function bracketPill(abbr, seed, game) {
    const button = el("button", "b-pill");
    button.type = "button";
    button.dataset.roadTeam = abbr;
    const row = state.roadResult && state.roadResult.teams[abbr];
    const prior = priorWeekRoad(abbr);
    if (state.roadTeam === abbr) button.classList.add("is-selected");
    if (row && row.eliminated) button.classList.add("is-out");
    if (state.roadDivision && divisionFor(abbr) && divisionFor(abbr).name !== state.roadDivision) button.classList.add("is-dim");
    if (row && prior && row.champion > prior.champion + 0.0005) button.classList.add("is-up");
    if (game && game.status === "in") button.classList.add("is-live");
    const winner = gameWinner(game);
    if (winner) button.classList.add(winner.abbr === abbr ? "is-winner" : "is-loser");
    button.append(logoImg(abbr));
    button.append(el("span", "b-name", `${League.team(abbr).short.toUpperCase()} (${seed})`));
    return button;
  }

  function bracketSlot(winner) {
    const slot = el("div", "b-slot");
    if (!winner) return slot;
    slot.classList.add("is-filled");
    slot.append(logoImg(winner.abbr));
    const name = el("button", "b-slot-hit");
    name.type = "button";
    name.dataset.roadTeam = winner.abbr;
    name.textContent = League.team(winner.abbr).short.toUpperCase();
    slot.append(name);
    return slot;
  }

  function barSide(team, className) {
    const side = el("div", `b-bar-side ${className}`);
    if (!team) return side;
    side.append(logoImg(team.abbr));
    const name = el("button", "b-slot-hit");
    name.type = "button";
    name.dataset.roadTeam = team.abbr;
    name.textContent = League.team(team.abbr).short.toUpperCase();
    side.append(name);
    return side;
  }

  function bracketSide(conference) {
    const plan = sidePlan(conference);
    const nfc = conference === "NFC";
    const quiet = state.roadConference !== "all" && state.roadConference !== conference;
    const side = el("div", `b-side is-${conference.toLowerCase()}${quiet ? " is-quiet" : ""}`);
    const edge = el("div", "b-edge", conference);
    const tree = el("div", nfc ? "b-tree is-nfc" : "b-tree");
    const places = [
      [plan.seeds[0], 1, "s1", null],
      [plan.seeds[1], 2, "s2", plan.pairs[0]],
      [plan.seeds[6], 7, "s7", plan.pairs[0]],
      [plan.seeds[2], 3, "s3", plan.pairs[1]],
      [plan.seeds[5], 6, "s6", plan.pairs[1]],
      [plan.seeds[3], 4, "s4", plan.pairs[2]],
      [plan.seeds[4], 5, "s5", plan.pairs[2]],
    ];
    places.forEach(([abbr, seed, area, game]) => {
      const pill = bracketPill(abbr, seed, game);
      pill.style.gridArea = area;
      tree.append(pill);
    });
    const bye = el("div", "b-bye-line");
    bye.style.gridArea = "line";
    tree.append(bye);
    ["hook", "hook2", "hook3"].forEach((area) => {
      const hook = el("div", "b-hook");
      hook.style.gridArea = area;
      tree.append(hook);
    });
    [plan.topWinner, plan.wildWinners[1], plan.wildWinners[2]].forEach((winner, index) => {
      const slot = bracketSlot(winner);
      slot.style.gridArea = ["d1", "d2", "d3"][index];
      tree.append(slot);
    });
    const mark = el("div", "b-letter", nfc ? "N" : "A");
    mark.style.gridArea = "mk";
    tree.append(mark);
    if (nfc) side.append(tree, edge);
    else side.append(edge, tree);
    return side;
  }

  function roadChart() {
    const wrap = el("div", "b-wrap");
    const board = el("div", "b-board");
    const afc = sidePlan("AFC");
    const nfc = sidePlan("NFC");
    const rounds = officialRounds();
    const superBowl = (rounds["Super Bowl"] || [])[0] || null;
    const champion = gameWinner(superBowl);
    const favorite = state.roadResult ? favoriteClub("", "champion") : null;
    const center = el("div", "b-center");
    const lockup = el("div", "b-lockup");
    lockup.append(el("span", "b-ball", ""));
    lockup.append(el("strong", "", "SUPER BOWL"));
    center.append(lockup);
    const favoriteButton = el("button", "b-proj");
    favoriteButton.type = "button";
    if (champion) {
      favoriteButton.dataset.roadTeam = champion.abbr;
      favoriteButton.textContent = `Champion · ${League.team(champion.abbr).short}`;
    } else if (favorite) {
      favoriteButton.dataset.roadTeam = favorite;
      favoriteButton.textContent = `${League.team(favorite).short} ${pctLabel(state.roadResult.teams[favorite].champion)} to win`;
    } else {
      favoriteButton.textContent = "Current seeds";
    }
    center.append(favoriteButton);
    const matchup = el("div", "b-sb-bar");
    matchup.append(barSide(afc.champ, "is-afc"), barSide(nfc.champ, "is-nfc"));
    const titleBar = el("div", "b-sb-bar is-short");
    if (champion) {
      const holder = el("div", "b-champion");
      holder.append(logoImg(champion.abbr));
      const name = el("button", "b-slot-hit");
      name.type = "button";
      name.dataset.roadTeam = champion.abbr;
      name.textContent = League.team(champion.abbr).short.toUpperCase();
      holder.append(name);
      titleBar.append(holder);
    }
    center.append(matchup, titleBar);
    board.append(bracketSide("AFC"), center, bracketSide("NFC"));
    board.append(el("div", "b-fifty", "50"));
    wrap.append(board);
    wrap.append(el("p", "b-caption", state.roadResult
      ? "The 14 clubs are the projected field. The No. 1 seed has a bye, then 2 plays 7, 3 plays 6, and 4 plays 5. Those clubs move after a game becomes final. The open rounds fill in when the playoff games are final."
      : "These are the current seeds. The projected clubs replace them when the projection finishes, and again after each final."));
    return wrap;
  }

  function roadBracket() {
    return roadChart();
  }

  function roadFavorites() {
    const wrap = el("div", "road-list");
    const ranked = Object.keys(state.roadResult.teams).sort((a, b) => state.roadResult.teams[b].champion - state.roadResult.teams[a].champion).slice(0, 8);
    ranked.forEach((abbr) => {
      const row = state.roadResult.teams[abbr];
      const prior = priorWeekRoad(abbr);
      const button = el("button", "road-row");
      button.type = "button";
      button.dataset.roadTeam = abbr;
      button.append(logoImg(abbr));
      const copy = el("div");
      copy.append(el("strong", row.champion > ((prior && prior.champion) || 0) + 0.0005 ? "is-up" : "", League.team(abbr).name));
      copy.append(el("p", "road-note", `${recordText(abbr)} · Playoffs ${pctLabel(row.playoff)} · Conference ${pctLabel(row.conference)} · Super Bowl ${pctLabel(row.superBowl)}`));
      button.append(copy);
      button.append(el("strong", "", pctLabel(row.champion)));
      wrap.append(button);
    });
    return wrap;
  }

  function roadHistoryView() {
    const wrap = el("div", "road-list");
    const history = ((state.modelStore && state.modelStore.roadHistory) || []).slice().reverse();
    if (!history.length) {
      wrap.append(el("p", "road-note", "No projection has been saved yet. The first one is stored when this chart finishes."));
      return wrap;
    }
    history.forEach((entry, index) => {
      const older = history[index + 1];
      const focus = state.roadTeam && entry.teams[state.roadTeam] ? state.roadTeam : Object.keys(entry.teams).sort((a, b) => entry.teams[b].champion - entry.teams[a].champion)[0];
      const current = entry.teams[focus].champion;
      const previous = older && older.teams[focus] ? older.teams[focus].champion : null;
      const row = el("div", "road-row");
      row.append(logoImg(focus));
      const copy = el("div");
      copy.append(el("strong", "", `Week ${entry.week} · ${entry.finals} final games`));
      copy.append(el("p", "road-note", `${League.team(focus).name}: ${pctLabel(current)} to win the Super Bowl. ${deltaLabel(current, previous)}`));
      row.append(copy);
      row.append(el("span", "", stamp(entry.savedAt)));
      wrap.append(row);
    });
    return wrap;
  }

  function roadOfficial() {
    const wrap = el("div", "road-list");
    if (!state.officialChecked) {
      wrap.append(el("p", "road-note", "Checking the official playoff bracket…"));
      return wrap;
    }
    if (!state.officialGames || !state.officialGames.length) {
      wrap.append(el("p", "road-note", "The official bracket is not available yet. The NFL has not posted playoff teams, so this chart stays projected."));
      return wrap;
    }
    state.officialGames.forEach((round) => {
      wrap.append(el("h3", "", round.name));
      round.games.forEach((game) => {
        const row = el("div", "road-match");
        const home = League.norm(game.home.abbr);
        const away = League.norm(game.away.abbr);
        const homeScore = League.numericScore(game.home.score);
        const awayScore = League.numericScore(game.away.score);
        let line = `${away} at ${home}`;
        if (game.status === "post" && homeScore != null && awayScore != null) line = `${away} ${awayScore}, ${home} ${homeScore}`;
        else if (game.status === "in") line = `${away} ${awayScore == null ? "—" : awayScore}, ${home} ${homeScore == null ? "—" : homeScore} · Live`;
        else line = `${line} · ${Season.formatShortDate(game.kickoffMs)} · ${Season.formatKickoff(game.kickoffMs)}`;
        row.append(el("p", "", line));
        wrap.append(row);
      });
    });
    return wrap;
  }

  function roadNote() {
    return el("p", "road-note", "Percentages come from simulations of the remaining games and the postseason. Each game uses the current team-strength model, opponent strength, and the rest of the schedule. A win does not add a fixed Super Bowl bump. Tiebreakers use head-to-head, division record, common games when there are at least four, conference record, strength of victory, strength of schedule, points ranks, and net points. Net touchdowns and the coin toss are not in the feed. Point tiebreakers use the current season totals.");
  }

  function renderRoadControls() {
    if (!els.roadControls) return;
    els.roadControls.replaceChildren();
    const buttons = [
      ["all", "All NFL Teams"],
      ["afc", "AFC"],
      ["nfc", "NFC"],
      ["history", "Weekly projection history"],
      ["bracket", "Projected Playoff Bracket"],
      ["official", "Official Playoff Bracket"],
      ["favorites", "Super Bowl Favorites"],
    ];
    buttons.forEach(([id, label]) => {
      const button = el("button", "", label);
      button.type = "button";
      button.dataset.roadView = id;
      const pressed = (id === "all" && state.roadView === "chart" && state.roadConference === "all" && !state.roadDivision)
        || (id === "afc" && state.roadView === "chart" && state.roadConference === "AFC")
        || (id === "nfc" && state.roadView === "chart" && state.roadConference === "NFC")
        || (id !== "all" && id !== "afc" && id !== "nfc" && state.roadView === id);
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
      els.roadControls.append(button);
    });
    const select = el("select", "road-division");
    select.id = "road-division";
    const allDivisions = el("option", "", "All divisions");
    allDivisions.value = "";
    select.append(allDivisions);
    League.DIVISIONS.forEach((division) => {
      const option = el("option", "", division.name);
      option.value = division.name;
      select.append(option);
    });
    select.value = state.roadDivision;
    els.roadControls.append(select);
  }

  function renderRoad() {
    if (!els.roadRoot) return;
    setText(els.roadMeta, roadMetaText());
    const official = state.officialGames && state.officialGames.length;
    setText(els.roadFlag, state.roadView === "official" && official ? "Official" : "Projected");
    renderRoadControls();
    els.roadRoot.replaceChildren();
    if (!state.roadResult && state.roadLoading) {
      if (Object.keys(state.records).length >= 30 && (state.roadView === "chart" || state.roadView === "bracket")) {
        els.roadRoot.append(el("p", "road-note", "Current seeds are on the bracket. The projected clubs replace them when the simulation finishes."));
        els.roadRoot.append(roadChart());
      } else els.roadRoot.append(el("p", "road-note", "Loading schedules and simulating the remaining season…"));
      return;
    }
    if (!state.roadResult && state.roadError) {
      els.roadRoot.append(el("p", "road-note", state.roadError));
      return;
    }
    if (!state.roadResult) return;
    if (state.roadTeam) els.roadRoot.append(roadDetail(state.roadTeam));
    if (state.roadView === "history") els.roadRoot.append(roadHistoryView());
    else if (state.roadView === "bracket") els.roadRoot.append(roadBracket());
    else if (state.roadView === "official") els.roadRoot.append(roadOfficial());
    else if (state.roadView === "favorites") els.roadRoot.append(roadFavorites());
    else els.roadRoot.append(roadChart());
    els.roadRoot.append(roadNote());
  }

  function drawRoadLines() {
    const chart = document.getElementById("road-chart");
    const svg = document.getElementById("road-lines");
    if (!chart || !svg) return;
    const box = chart.getBoundingClientRect();
    if (!box.width || !box.height) return;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    svg.setAttribute("width", String(box.width));
    svg.setAttribute("height", String(box.height));
    const visible = (node) => node && !node.closest("[hidden]");
    const point = (node, toward) => {
      const rect = node.getBoundingClientRect();
      const target = toward.getBoundingClientRect();
      const fromLeft = rect.left + rect.width / 2 <= target.left + target.width / 2;
      return {
        x: (fromLeft ? rect.right : rect.left) - box.left,
        y: rect.top + rect.height / 2 - box.top,
      };
    };
    const curve = (from, to, className) => {
      if (!visible(from) || !visible(to)) return "";
      const start = point(from, to);
      const end = point(to, from);
      const mid = (start.x + end.x) / 2;
      return `<path class="${className}" d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${mid.toFixed(1)} ${start.y.toFixed(1)}, ${mid.toFixed(1)} ${end.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}"></path>`;
    };
    let markup = "";
    ["AFC", "NFC"].forEach((conference) => {
      const divisions = chart.querySelector(`[data-conf="${conference}"] [data-stage="divisions"]`);
      const playoff = chart.querySelector(`[data-playoff="${conference}"]`);
      const champ = chart.querySelector(`[data-champ="${conference}"]`);
      const bowl = chart.querySelector("[data-sb]");
      markup += curve(divisions, playoff, "is-flow");
      markup += curve(playoff, champ, "is-flow");
      markup += curve(champ, bowl, "is-flow");
    });
    if (state.roadTeam && divisionFor(state.roadTeam)) {
      const conference = divisionFor(state.roadTeam).conference;
      const team = chart.querySelector(`[data-stage="divisions"] [data-road-team="${state.roadTeam}"]`);
      const playoff = chart.querySelector(`[data-playoff="${conference}"]`);
      const champ = chart.querySelector(`[data-champ="${conference}"]`);
      const bowl = chart.querySelector("[data-sb]");
      markup += curve(team, playoff, "is-path");
      markup += curve(playoff, champ, "is-path");
      markup += curve(champ, bowl, "is-path");
    }
    svg.innerHTML = markup;
  }

  function renderHomeBracket() {
    const root = document.getElementById("road-home-root");
    if (!root) return;
    const show = state.projView === "bracket";
    root.hidden = !show;
    if (!show) return;
    if (state.roadError && !state.roadResult) {
      root.replaceChildren(el("p", "road-note", state.roadError));
      return;
    }
    if (!state.roadResult && Object.keys(state.records).length < 30) {
      root.replaceChildren(el("p", "road-note", state.roadLoading ? "Updating the bracket…" : "Loading the bracket…"));
      return;
    }
    const wrap = el("div");
    if (state.roadTeam && state.roadResult && state.roadResult.teams[state.roadTeam]) wrap.append(roadDetail(state.roadTeam));
    wrap.append(roadChart());
    root.replaceChildren(wrap);
  }

  function updateBracket() {
    state.projView = "bracket";
    if (state.view !== "projections") showView("projections");
    state.roadSignature = "";
    state.roadToken += 1;
    state.roadLoading = false;
    if (els.roadTileCopy) els.roadTileCopy.textContent = "Updating the bracket…";
    renderProjections(true);
    ensureRoad();
  }

  function renderRoadTile() {
    renderHomeBracket();
    if (els.roadTile) {
      const on = state.projView === "bracket";
      els.roadTile.classList.toggle("is-selected", on);
      els.roadTile.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (!els.roadTileCopy) return;
    if (state.roadLoading) {
      els.roadTileCopy.textContent = "Updating the bracket…";
      return;
    }
    const result = state.roadResult;
    if (!result) {
      const history = (state.modelStore && state.modelStore.roadHistory) || [];
      const last = history[history.length - 1];
      if (!last) {
        els.roadTileCopy.textContent = "Click to update the bracket.";
        return;
      }
      const favorite = Object.keys(last.teams).sort((a, b) => last.teams[b].champion - last.teams[a].champion)[0];
      els.roadTileCopy.textContent = `Last saved projection: ${League.team(favorite).name} ${pctLabel(last.teams[favorite].champion)} to win the Super Bowl.`;
      return;
    }
    const favorite = favoriteClub("", "champion");
    els.roadTileCopy.textContent = `${League.team(favorite).name} ${pctLabel(result.teams[favorite].champion)} to win the Super Bowl.`;
  }

  function officialKey(rounds) {
    return (rounds || []).map((round) => `${round.name}:${round.games.map((game) => {
      const home = League.norm(game.home.abbr);
      const away = League.norm(game.away.abbr);
      return `${away}${League.numericScore(game.away.score)}@${home}${League.numericScore(game.home.score)}:${game.status}`;
    }).join(",")}`).join("|");
  }

  function loadOfficial(force) {
    if (state.officialChecked && !force) return;
    const request = ++state.officialToken;
    state.officialChecked = true;
    const rounds = [[1, "Wild Card"], [2, "Divisional"], [3, "Conference championship"], [4, "Super Bowl"]];
    Promise.all(rounds.map(async ([week, name]) => {
      const payload = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${state.seasonYear}&seasontype=3&week=${week}`).catch(() => null);
      if (!payload || !payload.season || Number(payload.season.type) !== 3) return null;
      const games = League.parseScoreboard(payload).games.filter((game) => League.TEAMS[League.norm(game.home.abbr)] && League.TEAMS[League.norm(game.away.abbr)]);
      return games.length ? { name, games } : null;
    })).then((rows) => {
      if (request !== state.officialToken) return;
      const next = rows.filter(Boolean);
      const key = officialKey(next);
      const changed = key !== state.officialKey;
      state.officialGames = next;
      state.officialKey = key;
      if (changed && state.roadOpen) renderRoad();
    });
  }

  function setRoadView(id) {
    if (id === "all") {
      state.roadView = "chart";
      state.roadConference = "all";
      state.roadDivision = "";
    } else if (id === "afc" || id === "nfc") {
      state.roadView = "chart";
      state.roadConference = id.toUpperCase();
      if (state.roadDivision && !state.roadDivision.startsWith(state.roadConference)) state.roadDivision = "";
    } else {
      state.roadView = id;
      if (id === "official") loadOfficial();
    }
    renderRoad();
  }

  function openRoad() {
    state.roadOpen = true;
    els.roadOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    const close = els.roadOverlay.querySelector("[data-road-close]");
    if (close) close.focus();
    loadOfficial(true);
    ensureRoad();
  }

  function closeRoad() {
    state.roadOpen = false;
    els.roadOverlay.hidden = true;
    document.body.style.overflow = "";
  }

  function ensureRoad() {
    if (state.roadLoading) return;
    const token = ++state.roadToken;
    state.roadLoading = true;
    state.roadError = "";
    renderRoad();
    renderRoadTile();
    (async () => {
      try {
        if (!state.modelReady) await ensureModel();
        if (token !== state.roadToken) return;
        const abbrs = Object.keys(League.TEAMS);
        const missing = abbrs.filter((abbr) => !state.teamSchedules.has(abbr));
        let cursor = 0;
        async function worker() {
          while (cursor < missing.length) {
            const abbr = missing[cursor];
            cursor += 1;
            if (token !== state.roadToken) return;
            await fetchTeamSchedule(abbr).catch(() => {});
          }
        }
        await Promise.all([worker(), worker(), worker(), worker()]);
        if (token !== state.roadToken) return;
        const failed = abbrs.filter((abbr) => !(state.teamSchedules.get(abbr) || []).length);
        if (failed.length || Object.keys(state.records).length < 30) {
          state.roadError = failed.length
            ? `Schedules did not load for ${failed.join(", ")}. No chart was calculated.`
            : "Standings have not loaded, so the chart was not calculated.";
          state.roadLoading = false;
          renderRoad();
          renderRoadTile();
          return;
        }
        const profiles = currentProfiles();
        const unready = abbrs.filter((abbr) => !profiles[abbr] || !profiles[abbr].ready);
        if (unready.length) {
          state.roadError = `Points scored and allowed are missing for ${unready.join(", ")}. No chart was calculated.`;
          state.roadLoading = false;
          renderRoad();
          renderRoadTile();
          return;
        }
        const signature = roadFinalsKey();
        if (state.roadResult && state.roadSignature === signature) {
          state.roadLoading = false;
          renderRoad();
          renderRoadTile();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        if (token !== state.roadToken) return;
        const completed = completedRows().map((game) => ({
          home: game.home,
          away: game.away,
          winner: game.homeScore === game.awayScore ? "TIE" : game.homeScore > game.awayScore ? game.home : game.away,
        }));
        const remaining = collectRemaining();
        const records = simulationRecords(completed);
        state.roadRecords = records;
        const result = Predict.roadSim({
          divisions: League.DIVISIONS,
          records,
          profiles,
          completed,
          remaining,
          sims: Predict.SIMS,
          rng: chartRandom(signature),
        });
        abbrs.forEach((abbr) => {
          const games = remaining.filter((game) => game.home === abbr || game.away === abbr);
          const expected = Predict.expectedRemaining(abbr, games, profiles);
          const record = records[abbr] || {};
          result.teams[abbr].projectedWins = (record.wins || 0) + expected;
          result.teams[abbr].projectedLosses = (record.losses || 0) + (games.length - expected);
          result.teams[abbr].eliminated = isEliminated(abbr, remaining);
        });
        state.roadResult = result;
        state.roadSignature = signature;
        rememberRoad(result);
        state.roadLoading = false;
        renderRoad();
        renderRoadTile();
      } catch (error) {
        if (token !== state.roadToken) return;
        state.roadLoading = false;
        state.roadError = "The projection could not be calculated from the current scores.";
        renderRoad();
        renderRoadTile();
      }
    })();
  }

  function renderAll(animate) {
    renderWeekControls();
    renderLiveBanner();
    renderFeatured();
    renderWeekBoard(false);
    if (animate) {
      restartMotion(els.featured);
      restartMotion(els.weekBoard);
    }
    renderStandings();
    renderTeams();
    renderSchedule();
    renderProjections();
    renderRoadTile();
    tick();
    setText(els.status, state.source);
  }

  function tick() {
    const caption = document.getElementById("countdown-caption");
    document.querySelectorAll("[data-kickoff]").forEach((node) => {
      const countdown = Season.computeCountdown(Number(node.dataset.kickoff));
      if (node.dataset.unit === "all") {
        node.textContent = countdown.isGameTime ? "Kickoff" : `${countdown.days}d ${countdown.hours}:${countdown.minutes}:${countdown.seconds}`;
        return;
      }
      node.textContent = countdown[node.dataset.unit] || "00";
      if (caption && countdown.isGameTime) caption.textContent = "Kickoff";
    });
    if (state.view === "projections") {
      const due = [...document.querySelectorAll("[data-kickoff-lock]")].some((node) => Number(node.dataset.kickoffLock) <= Date.now());
      if (due) renderProjections();
    }
  }

  function restartMotion(node) {
    node.classList.remove("is-entering");
    void node.offsetWidth;
    node.classList.add("is-entering");
  }

  function showView(name) {
    state.view = name;
    els.panels.forEach((panel) => {
      const on = panel.dataset.panel === name;
      panel.hidden = !on;
      if (on) restartMotion(panel);
    });
    els.views.forEach((button) => {
      const on = button.dataset.view === name;
      button.classList.toggle("is-selected", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  async function showWeek(week, animate) {
    const leavingMatchup = state.view === "nfl" && state.selectedGameId && !state.selectedTeam && week !== state.matchupWeek;
    if (leavingMatchup) {
      state.selectedGameId = null;
      state.matchupWeek = null;
    }
    state.week = week;
    renderWeekControls();
    setText(els.status, `Loading week ${week}…`);
    try {
      await fetchWeek(week);
      if (week === state.currentWeek && state.currentWeek < LAST_WEEK && !state.cache.has(state.currentWeek + 1)) {
        fetchWeek(state.currentWeek + 1).catch(() => {});
      }
      renderAll(animate);
    } catch (error) {
      renderAll(false);
      setText(els.status, "That week could not be loaded. Seattle's saved schedule is still available.");
    }
  }

  async function refresh() {
    els.refresh.disabled = true;
    state.cache.clear();
    state.modelReady = false;
    state.conferenceTried = {};
    state.roadSignature = "";
    state.officialChecked = false;
    state.officialGames = null;
    state.officialKey = "";
    const openTeamAbbr = state.selectedTeam;
    const matchupId = state.selectedGameId;
    const matchupWeek = state.matchupWeek;
    state.teamSchedules.clear();
    setText(els.status, "Refreshing the league schedule…");
    let modelJob = null;
    try {
      state.seasonYear = Season.currentNflSeasonYear();
      await loadSeason();
      try {
        const [board, standings] = await Promise.all([
          fetchJson("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"),
          fetchJson("https://site.api.espn.com/apis/v2/sports/football/nfl/standings").catch(() => null),
        ]);
        const parsed = League.parseScoreboard(board);
        state.currentWeek = parsed.week || state.nextGame && state.nextGame.week || 1;
        state.week = state.currentWeek;
        state.cache.set(state.currentWeek, parsed.games);
        state.dataUpdatedAt = new Date().toISOString();
        if (standings) state.records = League.parseStandings(standings);
        if (state.currentWeek < LAST_WEEK) {
          await fetchWeek(state.currentWeek + 1).catch(() => {});
        }
        if (openTeamAbbr && openTeamAbbr !== "SEA") {
          await fetchTeamSchedule(openTeamAbbr, true);
        }
        if (matchupId && matchupWeek) {
          state.selectedGameId = matchupId;
          state.matchupWeek = matchupWeek;
          state.week = matchupWeek;
          if (!state.cache.has(matchupWeek)) await fetchWeek(matchupWeek).catch(() => {});
        }
      } catch (error) {
        state.week = state.nextGame ? state.nextGame.week : 1;
        state.currentWeek = state.week;
      }
      renderAll(true);
      modelJob = ensureModel();
    } catch (error) {
      setText(els.status, "Schedule could not be loaded. Serve this folder over HTTP and try again.");
    } finally {
      els.refresh.disabled = false;
    }
    if (modelJob) await modelJob;
    if (!state.roadLoading && (!state.roadResult || state.roadSignature !== roadFinalsKey())) ensureRoad();
  }

  els.views.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view === "teams") {
        state.selectedTeam = null;
        state.teamFromMatchup = false;
      }
      showView(button.dataset.view);
      if (button.dataset.view === "teams") renderTeams();
      if (button.dataset.view === "projections") {
        if (!state.modelReady) ensureModel();
        renderProjections();
      }
    });
  });
  els.prevWeek.addEventListener("click", () => {
    if (state.week > 1) showWeek(state.week - 1, true);
  });
  els.nextWeek.addEventListener("click", () => {
    if (state.week < LAST_WEEK) showWeek(state.week + 1, true);
  });
  els.liveBanner.addEventListener("click", () => {
    showView("nfl");
    if (state.week !== state.currentWeek) showWeek(state.currentWeek, true);
  });
  els.refresh.addEventListener("click", refresh);
  if (els.roadTile) els.roadTile.addEventListener("click", updateBracket);
  const roadHome = document.getElementById("road-home-root");
  if (roadHome) {
    roadHome.addEventListener("click", (event) => {
      const team = event.target.closest("[data-road-team]");
      if (!team) return;
      state.roadTeam = state.roadTeam === team.dataset.roadTeam ? null : team.dataset.roadTeam;
      renderHomeBracket();
      if (state.roadOpen) renderRoad();
    });
  }
  if (els.roadOverlay) {
    els.roadOverlay.addEventListener("click", (event) => {
      if (event.target === els.roadOverlay || event.target.closest("[data-road-close]")) {
        closeRoad();
        return;
      }
      const view = event.target.closest("[data-road-view]");
      if (view) {
        setRoadView(view.dataset.roadView);
        return;
      }
      const team = event.target.closest("[data-road-team]");
      if (team) {
        state.roadTeam = state.roadTeam === team.dataset.roadTeam ? null : team.dataset.roadTeam;
        renderRoad();
      }
    });
    els.roadOverlay.addEventListener("change", (event) => {
      if (event.target.id !== "road-division") return;
      state.roadDivision = event.target.value;
      if (state.roadDivision) {
        const division = League.DIVISIONS.find((item) => item.name === state.roadDivision);
        if (division) state.roadConference = division.conference;
        state.roadView = "chart";
      }
      renderRoad();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.roadOpen) closeRoad();
  });
  window.addEventListener("resize", () => {
    if (state.roadOpen && state.roadView === "chart") drawRoadLines();
  });
  els.filters.forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      els.filters.forEach((item) => {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      renderSchedule();
    });
  });

  window.setInterval(tick, 1000);
  window.setInterval(async () => {
    if (!state.currentWeek) return;
    try {
      const previousGames = state.cache.get(state.currentWeek) || [];
      const previous = signature(previousGames);
      state.cache.delete(state.currentWeek);
      try {
        await fetchWeek(state.currentWeek);
      } catch (error) {
        state.cache.set(state.currentWeek, previousGames);
        return;
      }
      const next = signature(state.cache.get(state.currentWeek) || []);
      state.dataUpdatedAt = new Date().toISOString();
      renderLiveBanner();
      if (previous !== next && state.week === state.currentWeek) {
        renderAll(false);
        if ((state.roadOpen || state.roadResult) && !state.roadLoading && state.roadSignature !== roadFinalsKey()) ensureRoad();
      }
      if (state.roadOpen) loadOfficial(true);
    } catch (error) {
      /* Keep the board that is already on screen. */
    }
  }, 45000);

  refresh();
})();
