/**
 * NFL league directory and ESPN scoreboard/standings parsers.
 * Divisions follow the league's AFC/NFC alignment. Team colors are used
 * only as card accents.
 */
(function (global) {
  const ROWS = [
    ["ARI", "Cardinals", "Arizona Cardinals", "#97233F"],
    ["ATL", "Falcons", "Atlanta Falcons", "#C8102E"],
    ["BAL", "Ravens", "Baltimore Ravens", "#6d63d8"],
    ["BUF", "Bills", "Buffalo Bills", "#3d8bfd"],
    ["CAR", "Panthers", "Carolina Panthers", "#0085CA"],
    ["CHI", "Bears", "Chicago Bears", "#e25b2a"],
    ["CIN", "Bengals", "Cincinnati Bengals", "#FB4F14"],
    ["CLE", "Browns", "Cleveland Browns", "#ff4d1c"],
    ["DAL", "Cowboys", "Dallas Cowboys", "#4d8dff"],
    ["DEN", "Broncos", "Denver Broncos", "#FB4F14"],
    ["DET", "Lions", "Detroit Lions", "#0076B6"],
    ["GB", "Packers", "Green Bay Packers", "#FFB612"],
    ["HOU", "Texans", "Houston Texans", "#C8102E"],
    ["IND", "Colts", "Indianapolis Colts", "#3d6db5"],
    ["JAX", "Jaguars", "Jacksonville Jaguars", "#00b3a4"],
    ["KC", "Chiefs", "Kansas City Chiefs", "#E31837"],
    ["LV", "Raiders", "Las Vegas Raiders", "#c8c8c8"],
    ["LAC", "Chargers", "Los Angeles Chargers", "#0080C6"],
    ["LAR", "Rams", "Los Angeles Rams", "#ffd100"],
    ["MIA", "Dolphins", "Miami Dolphins", "#008E97"],
    ["MIN", "Vikings", "Minnesota Vikings", "#8a5cc4"],
    ["NE", "Patriots", "New England Patriots", "#c60c30"],
    ["NO", "Saints", "New Orleans Saints", "#d3bc8d"],
    ["NYG", "Giants", "New York Giants", "#6a7dff"],
    ["NYJ", "Jets", "New York Jets", "#2f9e62"],
    ["PHI", "Eagles", "Philadelphia Eagles", "#149898"],
    ["PIT", "Steelers", "Pittsburgh Steelers", "#FFB612"],
    ["SF", "49ers", "San Francisco 49ers", "#E31837"],
    ["SEA", "Seahawks", "Seattle Seahawks", "#69BE28"],
    ["TB", "Buccaneers", "Tampa Bay Buccaneers", "#E03A3E"],
    ["TEN", "Titans", "Tennessee Titans", "#4b92db"],
    ["WSH", "Commanders", "Washington Commanders", "#9b2743"],
  ];

  const TEAMS = {};
  ROWS.forEach((row) => {
    TEAMS[row[0]] = { abbr: row[0], short: row[1], name: row[2], color: row[3] };
  });

  /** ESPN team ids used by the same schedule endpoint as Seattle (team 26). */
  const ESPN_IDS = {
    ATL: "1", BUF: "2", CHI: "3", CIN: "4", CLE: "5", DAL: "6", DEN: "7", DET: "8",
    GB: "9", TEN: "10", IND: "11", KC: "12", LV: "13", LAR: "14", MIA: "15", MIN: "16",
    NE: "17", NO: "18", NYG: "19", NYJ: "20", PHI: "21", ARI: "22", PIT: "23", LAC: "24",
    SF: "25", SEA: "26", TB: "27", WSH: "28", CAR: "29", JAX: "30", BAL: "33", HOU: "34",
  };

  const DIVISIONS = [
    { conference: "AFC", name: "AFC East", teams: ["BUF", "MIA", "NE", "NYJ"] },
    { conference: "AFC", name: "AFC North", teams: ["BAL", "CIN", "CLE", "PIT"] },
    { conference: "AFC", name: "AFC South", teams: ["HOU", "IND", "JAX", "TEN"] },
    { conference: "AFC", name: "AFC West", teams: ["DEN", "KC", "LV", "LAC"] },
    { conference: "NFC", name: "NFC East", teams: ["DAL", "NYG", "PHI", "WSH"] },
    { conference: "NFC", name: "NFC North", teams: ["CHI", "DET", "GB", "MIN"] },
    { conference: "NFC", name: "NFC South", teams: ["ATL", "CAR", "NO", "TB"] },
    { conference: "NFC", name: "NFC West", teams: ["ARI", "LAR", "SF", "SEA"] },
  ];

  function norm(abbr) {
    const key = String(abbr || "").toUpperCase();
    if (key === "WAS") return "WSH";
    return key;
  }

  function team(abbr) {
    const key = norm(abbr);
    const known = TEAMS[key];
    if (!known) return { abbr: key || "NFL", short: key || "Team", name: key || "Team", color: "#8b939a", id: "" };
    return { ...known, id: ESPN_IDS[key] || "" };
  }

  function logo(abbr) {
    return Season.helmetUrl(norm(abbr));
  }

  function formatRecord(wins, losses, ties) {
    const record = `${wins}-${losses}`;
    return ties ? `${record}-${ties}` : record;
  }

  function readStat(stats, name) {
    return (stats || []).find((stat) => stat.name === name) || null;
  }

  function statValue(stats, name) {
    const stat = readStat(stats, name);
    if (!stat) return null;
    const value = Number(stat.value);
    if (Number.isFinite(value)) return value;
    const parsed = Number(String(stat.displayValue || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function statText(stats, name) {
    const stat = readStat(stats, name);
    return stat && stat.displayValue ? String(stat.displayValue) : "";
  }

  function isPostponed(statusType) {
    const name = `${statusType && statusType.name || ""} ${statusType && statusType.description || ""}`.toUpperCase();
    return name.includes("POSTPONED") || name.includes("DELAYED") || name.includes("SUSPENDED");
  }

  function parseStandings(payload) {
    const records = {};
    ((payload && payload.children) || []).forEach((conference) => {
      const entries = conference.standings && conference.standings.entries;
      (entries || []).forEach((entry) => {
        const abbr = norm(entry.team && entry.team.abbreviation);
        const stats = entry.stats || [];
        const wins = Number(readStat(stats, "wins") && readStat(stats, "wins").value) || 0;
        const losses = Number(readStat(stats, "losses") && readStat(stats, "losses").value) || 0;
        const ties = Number(readStat(stats, "ties") && readStat(stats, "ties").value) || 0;
        const diffStat = readStat(stats, "pointDifferential");
        const overall = readStat(stats, "overall");
        records[abbr] = {
          wins,
          losses,
          ties,
          diff: diffStat ? Number(diffStat.value) || 0 : 0,
          summary: overall && overall.displayValue ? overall.displayValue : formatRecord(wins, losses, ties),
          id: entry.team && entry.team.id ? String(entry.team.id) : ESPN_IDS[abbr] || "",
          pointsFor: statValue(stats, "pointsFor"),
          pointsAgainst: statValue(stats, "pointsAgainst"),
          divisionRecord: statText(stats, "divisionRecord"),
          streak: statText(stats, "streak"),
          playoffSeed: statText(stats, "playoffSeed"),
          homeRecord: statText(stats, "Home"),
          roadRecord: statText(stats, "Road"),
          conferenceRecord: statText(stats, "vs. Conf."),
        };
      });
    });
    return records;
  }

  function sideFromCompetitor(comp) {
    const abbr = norm(comp.team && comp.team.abbreviation);
    const total = (comp.records || []).find((record) => record.type === "total" || record.name === "overall");
    return {
      abbr,
      record: total && total.summary ? total.summary : "",
      score: comp.score,
    };
  }

  function parseScoreboard(payload) {
    const week = payload && payload.week ? payload.week.number : null;
    const games = ((payload && payload.events) || [])
      .map((event) => {
        const competition = event.competitions && event.competitions[0];
        if (!competition) return null;
        const statusNode = competition.status || event.status || {};
        const statusType = statusNode.type || {};
        let status = "pre";
        if (statusType.state === "in") status = "in";
        else if (statusType.state === "post" || statusType.completed) status = "post";
        const postponed = isPostponed(statusType);
        const kickoffMs = Date.parse(event.date);
        if (!Number.isFinite(kickoffMs)) return null;
        let home = null;
        let away = null;
        (competition.competitors || []).forEach((comp) => {
          const side = sideFromCompetitor(comp);
          if (comp.homeAway === "home") home = side;
          else away = side;
        });
        if (!home || !away) return null;
        const venue = competition.venue || {};
        return {
          id: event.id,
          week,
          kickoffMs,
          status,
          postponed,
          neutral: Boolean(competition.neutralSite),
          clock: statusNode.displayClock || "",
          period: statusNode.period || 0,
          venue: venue.fullName || venue.displayName || "",
          home,
          away,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.kickoffMs - b.kickoffMs);
    return { week, games };
  }

  function numericScore(score) {
    if (score == null || score === "") return null;
    if (typeof score === "number") return Number.isFinite(score) ? score : null;
    if (typeof score === "string") {
      const parsed = Number.parseInt(score, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof score === "object") {
      if (score.displayValue != null && score.displayValue !== "") {
        const parsed = Number.parseInt(score.displayValue, 10);
        return Number.isFinite(parsed) ? parsed : null;
      }
      if (typeof score.value === "number") return score.value;
    }
    return null;
  }

  /**
   * Full regular-season schedule for one club from
   * /teams/{id}/schedule, the same endpoint already used for the Seahawks.
   * Live games on this feed can omit scores; the scoreboard fill-in stays in app.js.
   */
  function parseTeamSchedule(payload, teamId) {
    const id = String(teamId);
    return ((payload && payload.events) || [])
      .map((event) => {
        const seasonType = event.seasonType && event.seasonType.type;
        if (seasonType && seasonType !== 2) return null;
        const competition = event.competitions && event.competitions[0];
        if (!competition) return null;
        const kickoffMs = Date.parse(event.date);
        if (!Number.isFinite(kickoffMs)) return null;
        const statusNode = competition.status || event.status || {};
        const statusType = statusNode.type || {};
        let status = "pre";
        if (statusType.state === "in") status = "in";
        else if (statusType.state === "post" || statusType.completed) status = "post";
        const postponed = isPostponed(statusType);
        let teamAbbr = "";
        let isHome = true;
        let teamScore = null;
        let opponent = "TBD";
        let opponentAbbr = "";
        let opponentScore = null;
        (competition.competitors || []).forEach((comp) => {
          const abbr = norm(comp.team && comp.team.abbreviation);
          const score = numericScore(comp.score);
          if (String(comp.team && comp.team.id) === id) {
            teamAbbr = abbr;
            isHome = comp.homeAway === "home";
            teamScore = score;
          } else {
            opponent = (comp.team && (comp.team.displayName || comp.team.name)) || "TBD";
            opponentAbbr = abbr;
            opponentScore = score;
          }
        });
        if (!teamAbbr || !opponentAbbr) return null;
        let result = "";
        if (status === "post" && teamScore != null && opponentScore != null) {
          if (teamScore > opponentScore) result = "W";
          else if (teamScore < opponentScore) result = "L";
          else result = "T";
        }
        const venue = competition.venue || {};
        return {
          id: event.id,
          week: event.week && event.week.number ? event.week.number : 0,
          kickoffMs,
          status,
          postponed,
          clock: statusNode.displayClock || "",
          period: statusNode.period || 0,
          isHome,
          teamAbbr,
          teamScore,
          opponent,
          opponentAbbr,
          opponentScore,
          result,
          venue: venue.fullName || venue.displayName || "",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.kickoffMs - b.kickoffMs || a.week - b.week);
  }

  function involves(game, abbr) {
    const key = norm(abbr);
    return game.home.abbr === key || game.away.abbr === key;
  }

  global.League = {
    DIVISIONS,
    TEAMS,
    norm,
    team,
    logo,
    formatRecord,
    parseStandings,
    parseScoreboard,
    parseTeamSchedule,
    numericScore,
    involves,
  };
})(window);
