/**
 * Season logic for the Seahawks kickoff dashboard.
 * Mirrors the widget SeasonEngine: NFL season year, next game, countdown.
 * A result on a game that has not kicked off yet is ignored so placeholder
 * scores cannot skip the real next kickoff.
 */
(function (global) {
  const GAME_DURATION_MS = 4 * 60 * 60 * 1000;
  const TZ = "America/Los_Angeles";
  const ESPN_LOGO = "https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/";

  const TEAM_ABBR = {
    "Arizona Cardinals": "ARI",
    "Atlanta Falcons": "ATL",
    "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF",
    "Carolina Panthers": "CAR",
    "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN",
    "Cleveland Browns": "CLE",
    "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN",
    "Detroit Lions": "DET",
    "Green Bay Packers": "GB",
    "Houston Texans": "HOU",
    "Indianapolis Colts": "IND",
    "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC",
    "Las Vegas Raiders": "LV",
    "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR",
    "Miami Dolphins": "MIA",
    "Minnesota Vikings": "MIN",
    "New England Patriots": "NE",
    "New Orleans Saints": "NO",
    "New York Giants": "NYG",
    "New York Jets": "NYJ",
    "Philadelphia Eagles": "PHI",
    "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF",
    "Seattle Seahawks": "SEA",
    "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN",
    "Washington Commanders": "WAS",
  };

  function currentNflSeasonYear(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "numeric",
    }).formatToParts(now);
    const year = Number(parts.find((part) => part.type === "year").value);
    const month = Number(parts.find((part) => part.type === "month").value);
    return month <= 2 ? year - 1 : year;
  }

  function seasonLabel(year) {
    return `${year}–${year + 1} Season`;
  }

  function parseKickoff(kickoff) {
    const ms = Date.parse(kickoff);
    return Number.isFinite(ms) ? ms : null;
  }

  function helmetUrl(abbr) {
    const fixed = String(abbr || "").toUpperCase() === "WAS" ? "wsh" : String(abbr || "nfl").toLowerCase();
    return `${ESPN_LOGO}${fixed}.png`;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatInZone(ms, options) {
    return new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(new Date(ms));
  }

  function extractScore(score) {
    if (score == null) return 0;
    if (typeof score === "number") return score;
    if (typeof score === "string") return Number.parseInt(score, 10) || 0;
    if (typeof score === "object") {
      if (score.displayValue != null) return Number.parseInt(score.displayValue, 10) || 0;
      if (typeof score.value === "number") return score.value;
    }
    return 0;
  }

  function enrichGames(games, now = Date.now()) {
    let nextMarked = false;
    return games.map((game) => {
      const kickoffMs = game.kickoffMs;
      const kickedOff = kickoffMs <= now;
      const result = kickedOff ? game.result || "" : "";
      const isPast = Boolean(result) || kickoffMs + GAME_DURATION_MS < now;
      const isNext = !isPast && !nextMarked;
      if (isNext) nextMarked = true;
      return {
        ...game,
        result,
        isPast,
        isNext,
        isWin: result.startsWith("W"),
        isLoss: result.startsWith("L"),
        isTie: result.startsWith("T"),
      };
    });
  }

  function gamesFromSchedule(schedule, now = Date.now()) {
    const raw = (schedule.games || [])
      .map((game) => {
        const kickoffMs = parseKickoff(game.kickoff);
        if (kickoffMs == null) return null;
        return {
          week: game.week,
          opponent: game.opponent,
          opponentAbbr: game.opponentAbbr || TEAM_ABBR[game.opponent] || "",
          kickoffMs,
          venue: game.venue,
          isHome: Boolean(game.isHome),
          result: game.result || "",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.kickoffMs - b.kickoffMs || a.week - b.week);
    return enrichGames(raw, now);
  }

  function gamesFromEspn(payload, now = Date.now()) {
    const events = payload && payload.events;
    if (!Array.isArray(events)) return [];
    const raw = events
      .map((event, index) => {
        const kickoffMs = parseKickoff(event.date);
        if (kickoffMs == null) return null;
        const competition = event.competitions && event.competitions[0];
        if (!competition) return null;
        const completed = Boolean(competition.status && competition.status.type && competition.status.type.completed);
        let opponent = "TBD";
        let opponentAbbr = "";
        let isHome = true;
        let seahawksScore = 0;
        let opponentScore = 0;
        (competition.competitors || []).forEach((comp) => {
          const team = comp.team || {};
          const score = extractScore(comp.score);
          if (String(team.id) === "26") {
            isHome = comp.homeAway === "home";
            seahawksScore = score;
          } else {
            opponent = team.displayName || team.name || "TBD";
            opponentAbbr = team.abbreviation || TEAM_ABBR[opponent] || "";
            opponentScore = score;
          }
        });
        let result = "";
        if (completed) {
          if (seahawksScore > opponentScore) result = `W ${seahawksScore}-${opponentScore}`;
          else if (seahawksScore < opponentScore) result = `L ${seahawksScore}-${opponentScore}`;
          else result = `T ${seahawksScore}-${opponentScore}`;
        }
        const weekNumber = event.week && event.week.number ? event.week.number : index + 1;
        const venueObj = competition.venue || {};
        return {
          week: weekNumber,
          opponent,
          opponentAbbr,
          kickoffMs,
          venue: venueObj.fullName || venueObj.displayName || "TBD",
          isHome,
          result,
        };
      })
      .filter(Boolean);
    return enrichGames(raw, now);
  }

  function findNextGame(games) {
    return games.find((game) => !game.isPast) || null;
  }

  function recordFromGames(games) {
    const played = games.filter((game) => game.isPast && game.result);
    return {
      wins: played.filter((game) => game.isWin).length,
      losses: played.filter((game) => game.isLoss).length,
      ties: played.filter((game) => game.isTie).length,
      played: played.length,
      total: games.length,
    };
  }

  function computeCountdown(kickoffMs, now = Date.now()) {
    const diff = kickoffMs - now;
    if (diff <= 0) {
      return { days: "00", hours: "00", minutes: "00", seconds: "00", isGameTime: true };
    }
    const totalSeconds = Math.floor(diff / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return {
      days: pad(days),
      hours: pad(hours),
      minutes: pad(minutes),
      seconds: pad(seconds),
      isGameTime: false,
    };
  }

  function formatGameDay(ms) {
    return formatInZone(ms, { weekday: "long" }).toUpperCase();
  }

  function formatKickoff(ms) {
    const time = formatInZone(ms, { hour: "numeric", minute: "2-digit" });
    return `${time} PT`;
  }

  function formatShortDate(ms) {
    return formatInZone(ms, { month: "short", day: "numeric" });
  }

  function formatWeekdayShort(ms) {
    return formatInZone(ms, { weekday: "short" });
  }

  global.Season = {
    TEAM_ABBR,
    currentNflSeasonYear,
    seasonLabel,
    helmetUrl,
    gamesFromSchedule,
    gamesFromEspn,
    findNextGame,
    recordFromGames,
    computeCountdown,
    formatGameDay,
    formatKickoff,
    formatShortDate,
    formatWeekdayShort,
    parseKickoff,
  };
})(window);
