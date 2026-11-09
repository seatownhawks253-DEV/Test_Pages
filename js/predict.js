/**
 * Margin model v1.
 *
 * Keep the constants in tools/update_predictions.py identical.
 *
 * Team strength uses only numbers from the loaded season:
 *   season point margin per game (70%)
 *   last five completed games' margin per game (30%, when at least 3 exist)
 *   turnover differential per game times 0.7 points, when that statistic was loaded
 *   minus (opponent win percentage - .500) times 6
 *
 * A matchup margin is home strength minus away strength, plus 2.5 points at
 * the home team's stadium. A neutral site does not get those points. The last
 * head-to-head result this season, if one exists, moves the margin by 0.5.
 *
 * Win probability is 1 / (1 + e^(-margin / 13)).
 * A 3-point margin is about a 55.7% chance. This is a model scale, not a
 * team statistic.
 *
 * ESPN's injury report has statuses, not a point value, so injuries are not
 * in the score. ESPN standings include the current playoff seed, not a
 * playoff percentage. Playoff and division chances below are simulated from
 * this model. Tie-breaks in that simulation are win percentage, then the
 * current point differential. That is shorter than the official NFL list.
 *
 * Predictions for games that have not kicked off are replaced as new results
 * arrive. Once kickoff has passed, the last saved prediction is frozen.
 * Games that already started before any prediction was saved are not given
 * a backfilled pick.
 */
(function (global) {
  const HOME_FIELD = 2.5;
  const LOGISTIC_SCALE = 13;
  const SEASON_WEIGHT = 0.7;
  const RECENT_WEIGHT = 0.3;
  const TURNOVER_POINT = 0.7;
  const SOS_SCALE = 6;
  const H2H_BUMP = 0.5;
  const SIMS = 2000;

  function sigmoid(margin) {
    return 1 / (1 + Math.exp(-margin / LOGISTIC_SCALE));
  }

  function roundScore(value) {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.round(value));
  }

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function readTurnover(payload) {
    const categories = payload && payload.results && payload.results.stats && payload.results.stats.categories;
    if (!categories) return null;
    const misc = categories.find((category) => category.name === "miscellaneous");
    const stat = misc && (misc.stats || []).find((item) => item.name === "turnOverDifferential");
    if (!stat || stat.value == null || stat.value === "") return null;
    const value = Number(stat.value);
    return Number.isFinite(value) ? value : null;
  }

  function buildIndex(completed) {
    const byTeam = {};
    const meetings = {};
    (completed || []).forEach((game) => {
      const homeScore = Number(game.homeScore);
      const awayScore = Number(game.awayScore);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
      const winner = homeScore === awayScore ? "TIE" : homeScore > awayScore ? game.home : game.away;
      const row = {
        kickoffMs: game.kickoffMs,
        week: game.week,
        home: game.home,
        away: game.away,
        winner,
      };
      const pair = [game.home, game.away].sort().join("-");
      meetings[pair] = meetings[pair] || [];
      meetings[pair].push(row);
      [
        { abbr: game.home, margin: homeScore - awayScore, result: homeScore === awayScore ? "T" : homeScore > awayScore ? "W" : "L" },
        { abbr: game.away, margin: awayScore - homeScore, result: awayScore === homeScore ? "T" : awayScore > homeScore ? "W" : "L" },
      ].forEach((side) => {
        byTeam[side.abbr] = byTeam[side.abbr] || [];
        byTeam[side.abbr].push({
          kickoffMs: game.kickoffMs,
          week: game.week,
          opponent: side.abbr === game.home ? game.away : game.home,
          margin: side.margin,
          result: side.result,
        });
      });
    });
    Object.values(byTeam).forEach((list) => list.sort((a, b) => a.kickoffMs - b.kickoffMs));
    Object.values(meetings).forEach((list) => list.sort((a, b) => a.kickoffMs - b.kickoffMs));
    return { byTeam, meetings };
  }

  function h2hBump(home, away, index) {
    const list = index.meetings[[home, away].sort().join("-")] || [];
    if (!list.length) return { points: 0, winner: "" };
    const last = list[list.length - 1];
    if (last.winner === "TIE") return { points: 0, winner: "TIE" };
    return { points: last.winner === home ? H2H_BUMP : -H2H_BUMP, winner: last.winner };
  }

  function profile(abbr, records, index, turnovers) {
    const record = records[abbr] || {};
    const games = (record.wins || 0) + (record.losses || 0) + (record.ties || 0);
    const pointsFor = record.pointsFor;
    const pointsAgainst = record.pointsAgainst;
    const recentAll = (index.byTeam && index.byTeam[abbr]) || [];
    const recent = recentAll.slice(-5);
    const ready = games > 0 && pointsFor != null && pointsAgainst != null;
    const seasonMargin = ready ? (pointsFor - pointsAgainst) / games : 0;
    const recentMargin = recent.length ? average(recent.map((game) => game.margin)) : seasonMargin;
    const blended = ready && recent.length >= 3
      ? SEASON_WEIGHT * seasonMargin + RECENT_WEIGHT * recentMargin
      : seasonMargin;
    const turnover = turnovers && Object.prototype.hasOwnProperty.call(turnovers, abbr) ? turnovers[abbr] : null;
    const turnoverPoints = ready && turnover != null ? (turnover / games) * TURNOVER_POINT : 0;
    const opponents = recentAll.map((game) => records[game.opponent]).filter(Boolean);
    const sos = opponents.length
      ? average(opponents.map((item) => {
        const played = (item.wins || 0) + (item.losses || 0) + (item.ties || 0);
        return played ? ((item.wins || 0) + 0.5 * (item.ties || 0)) / played : 0.5;
      }))
      : 0.5;
    return {
      abbr,
      ready,
      games,
      record: record.summary || "—",
      pointsFor,
      pointsAgainst,
      ppg: ready ? pointsFor / games : null,
      papg: ready ? pointsAgainst / games : null,
      seasonMargin,
      recentMargin,
      recent: recent.map((game) => game.result),
      turnover,
      turnoverPoints,
      sos,
      strength: blended + turnoverPoints - (sos - 0.5) * SOS_SCALE,
    };
  }

  function confidence(prob, gamesA, gamesB) {
    const edge = Math.abs(prob - 0.5);
    const games = Math.min(gamesA, gamesB);
    if (games < 3) return "Low";
    if (edge >= 0.12 && games >= 5) return "High";
    if (edge >= 0.06) return "Medium";
    return "Low";
  }

  function explain(homeName, awayName, home, away, margin, prob, neutral, head, names) {
    if (!home.ready || !away.ready) {
      return "This game is not projected yet because points scored and points allowed are missing from the standings feed.";
    }
    const sentences = [
      `${homeName}: ${home.record}, ${home.ppg.toFixed(1)} points scored per game, ${home.papg.toFixed(1)} allowed.`,
      `${awayName}: ${away.record}, ${away.ppg.toFixed(1)} points scored per game, ${away.papg.toFixed(1)} allowed.`,
    ];
    if (home.recent.length) {
      sentences.push(`${homeName} last ${home.recent.length} completed games: ${home.recent.join(" ")} (average margin ${home.recentMargin.toFixed(1)}).`);
    }
    if (away.recent.length) {
      sentences.push(`${awayName} last ${away.recent.length} completed games: ${away.recent.join(" ")} (average margin ${away.recentMargin.toFixed(1)}).`);
    }
    sentences.push(neutral
      ? "The site is neutral, so the model adds no home-field points."
      : "The model adds 2.5 points for the home team.");
    if (head.winner && head.winner !== "TIE") {
      sentences.push(`Their latest meeting this season adds 0.5 points toward ${(names && names[head.winner]) || head.winner}.`);
    } else if (head.winner === "TIE") {
      sentences.push("Their latest meeting this season was a tie, so it does not move the margin.");
    }
    if (home.turnover == null || away.turnover == null) {
      sentences.push("Turnover margin was not available for both teams, so it is not in this score.");
    } else {
      sentences.push(`Season turnover margins are ${homeName} ${home.turnover} and ${awayName} ${away.turnover}.`);
    }
    sentences.push(`The projected margin is ${margin.toFixed(1)} points, which this scale treats as a ${(prob * 100).toFixed(0)}% chance for ${homeName}.`);
    return sentences.join(" ");
  }

  function project(home, away, profiles, neutral, names) {
    const homeProfile = profiles[home];
    const awayProfile = profiles[away];
    if (!homeProfile || !awayProfile || !homeProfile.ready || !awayProfile.ready) return null;
    const head = h2hBump(home, away, profiles.__index || { meetings: {} });
    const margin = homeProfile.strength - awayProfile.strength + (neutral ? 0 : HOME_FIELD) + head.points;
    const homeWinProb = sigmoid(margin);
    const total = (homeProfile.ppg + awayProfile.papg) / 2 + (awayProfile.ppg + homeProfile.papg) / 2;
    let homeScore = roundScore((total + margin) / 2);
    let awayScore = roundScore((total - margin) / 2);
    if (homeScore === awayScore && Math.abs(homeWinProb - 0.5) >= 0.005) {
      if (homeWinProb > 0.5) homeScore += 1;
      else awayScore += 1;
    }
    const winner = homeScore === awayScore ? "TIE" : homeScore > awayScore ? home : away;
    const homeName = (names && names[home]) || home;
    const awayName = (names && names[away]) || away;
    return {
      winner,
      homeScore,
      awayScore,
      homeWinProb,
      awayWinProb: 1 - homeWinProb,
      margin,
      confidence: confidence(homeWinProb, homeProfile.games, awayProfile.games),
      explanation: explain(homeName, awayName, homeProfile, awayProfile, margin, homeWinProb, neutral, head, names),
      recentHome: homeProfile.recent.slice(),
      recentAway: awayProfile.recent.slice(),
    };
  }

  function profilesFor(records, index, turnovers) {
    const profiles = { __index: index };
    Object.keys(records || {}).forEach((abbr) => {
      profiles[abbr] = profile(abbr, records, index, turnovers || {});
    });
    return profiles;
  }

  function homeProb(home, away, profiles, neutral) {
    const pick = project(home, away, profiles, neutral);
    return pick ? pick.homeWinProb : 0.5;
  }

  function expectedRemaining(abbr, games, profiles) {
    let expected = 0;
    (games || []).forEach((game) => {
      const prob = homeProb(game.home, game.away, profiles, game.neutral);
      if (game.home === abbr) expected += prob;
      else if (game.away === abbr) expected += 1 - prob;
    });
    return expected;
  }

  function playoffOdds(conference, divisions, remaining, records, profiles, rng) {
    const random = rng || Math.random;
    const groups = divisions.filter((division) => division.conference === conference);
    const teams = groups.flatMap((division) => division.teams);
    const teamSet = new Set(teams);
    const baseWins = {};
    const baseLosses = {};
    const diff = {};
    teams.forEach((abbr) => {
      const record = records[abbr] || {};
      baseWins[abbr] = record.wins || 0;
      baseLosses[abbr] = record.losses || 0;
      diff[abbr] = record.diff || 0;
    });
    const titles = {};
    const berths = {};
    teams.forEach((abbr) => {
      titles[abbr] = 0;
      berths[abbr] = 0;
    });
    const probs = remaining.map((game) => ({
      game,
      prob: homeProb(game.home, game.away, profiles, game.neutral),
    }));
    for (let sim = 0; sim < SIMS; sim += 1) {
      const wins = { ...baseWins };
      const losses = { ...baseLosses };
      probs.forEach((item) => {
        const homeWins = random() < item.prob;
        [item.game.home, item.game.away].forEach((abbr, index) => {
          if (!teamSet.has(abbr)) return;
          const won = index === 0 ? homeWins : !homeWins;
          if (won) wins[abbr] += 1;
          else losses[abbr] += 1;
        });
      });
      const pct = (abbr) => {
        const played = wins[abbr] + losses[abbr];
        return played ? wins[abbr] / played : 0;
      };
      const order = (list) => list.slice().sort((a, b) => pct(b) - pct(a) || diff[b] - diff[a]);
      const winners = [];
      groups.forEach((division) => {
        const winner = order(division.teams)[0];
        winners.push(winner);
        titles[winner] += 1;
      });
      const wild = order(teams.filter((abbr) => !winners.includes(abbr))).slice(0, 3);
      winners.concat(wild).forEach((abbr) => {
        berths[abbr] += 1;
      });
    }
    const odds = {};
    teams.forEach((abbr) => {
      odds[abbr] = {
        division: titles[abbr] / SIMS,
        playoff: berths[abbr] / SIMS,
      };
    });
    return odds;
  }

  function parseRecordText(text) {
    const parts = String(text || "").split("-").map((part) => Number(part));
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return { w: 0, l: 0, t: 0 };
    return { w: parts[0] || 0, l: parts[1] || 0, t: parts[2] || 0 };
  }

  function leagueMaps(divisions) {
    const divisionOf = {};
    const conferenceOf = {};
    (divisions || []).forEach((division) => {
      division.teams.forEach((abbr) => {
        divisionOf[abbr] = division.name;
        conferenceOf[abbr] = division.conference;
      });
    });
    return { divisionOf, conferenceOf };
  }

  /**
   * Rank clubs with the NFL steps we can calculate from games and standings.
   * Head-to-head, division record, common games (at least four), conference
   * record, strength of victory, strength of schedule, points-scored and
   * points-allowed ranks, then net points. Net touchdowns and the coin toss
   * are not in the feed, so a remaining tie keeps the previous order.
   * Higher scores rank first.
   */
  function orderClubs(list, stepsOrResolve) {
    if (list.length <= 1) return list.slice();
    const steps = typeof stepsOrResolve === "function" ? stepsOrResolve(list) : stepsOrResolve;
    for (let index = 0; index < steps.length; index += 1) {
      let best = -Infinity;
      const scores = list.map((team) => {
        const score = steps[index](team, list);
        if (score > best) best = score;
        return score;
      });
      const top = list.filter((team, teamIndex) => scores[teamIndex] === best);
      if (!top.length || top.length === list.length) continue;
      const rest = list.filter((team) => !top.includes(team));
      if (top.length === 1) return top.concat(orderClubs(rest, stepsOrResolve));
      return orderClubs(top, stepsOrResolve).concat(orderClubs(rest, stepsOrResolve));
    }
    return list.slice();
  }

  function roadSim(options) {
    const random = options.rng || Math.random;
    const sims = options.sims || SIMS;
    const divisions = options.divisions || [];
    const records = options.records || {};
    const profiles = options.profiles;
    const { divisionOf, conferenceOf } = leagueMaps(divisions);
    const teams = divisions.flatMap((division) => division.teams);
    const base = {};
    teams.forEach((abbr) => {
      const record = records[abbr] || {};
      const divisionRecord = parseRecordText(record.divisionRecord);
      const conferenceRecord = parseRecordText(record.conferenceRecord);
      base[abbr] = {
        w: record.wins || 0,
        l: record.losses || 0,
        t: record.ties || 0,
        dw: divisionRecord.w,
        dl: divisionRecord.l,
        dt: divisionRecord.t,
        cw: conferenceRecord.w,
        cl: conferenceRecord.l,
        ct: conferenceRecord.t,
        defeated: {},
        played: {},
        pf: record.pointsFor || 0,
        pa: record.pointsAgainst || 0,
      };
    });
    (options.completed || []).forEach((game) => {
      if (!base[game.home] || !base[game.away] || !game.winner || game.winner === "TIE") return;
      const loser = game.winner === game.home ? game.away : game.home;
      base[game.winner].defeated[loser] = (base[game.winner].defeated[loser] || 0) + 1;
      base[game.winner].played[loser] = (base[game.winner].played[loser] || 0) + 1;
      base[loser].played[game.winner] = (base[loser].played[game.winner] || 0) + 1;
    });
    const pointRanks = (clubList, read) => {
      const rank = {};
      clubList.slice().sort((a, b) => read(a) - read(b)).forEach((abbr, index) => {
        rank[abbr] = index + 1;
      });
      return rank;
    };
    const conferenceClubs = (conference) => teams.filter((abbr) => conferenceOf[abbr] === conference);
    const pfConf = {
      AFC: pointRanks(conferenceClubs("AFC"), (abbr) => -(records[abbr] && records[abbr].pointsFor || 0)),
      NFC: pointRanks(conferenceClubs("NFC"), (abbr) => -(records[abbr] && records[abbr].pointsFor || 0)),
    };
    const paConf = {
      AFC: pointRanks(conferenceClubs("AFC"), (abbr) => records[abbr] && records[abbr].pointsAgainst || 0),
      NFC: pointRanks(conferenceClubs("NFC"), (abbr) => records[abbr] && records[abbr].pointsAgainst || 0),
    };
    const pfLeague = pointRanks(teams, (abbr) => -(records[abbr] && records[abbr].pointsFor || 0));
    const paLeague = pointRanks(teams, (abbr) => records[abbr] && records[abbr].pointsAgainst || 0);
    const tally = {};
    const brackets = { AFC: {}, NFC: {} };
    teams.forEach((abbr) => {
      tally[abbr] = { division: 0, playoff: 0, conference: 0, superBowl: 0, champion: 0, seeds: [0, 0, 0, 0, 0, 0, 0, 0] };
    });

    function cloneTable() {
      const table = {};
      teams.forEach((abbr) => {
        const row = base[abbr];
        table[abbr] = {
          w: row.w,
          l: row.l,
          t: row.t,
          dw: row.dw,
          dl: row.dl,
          dt: row.dt,
          cw: row.cw,
          cl: row.cl,
          ct: row.ct,
          defeated: { ...row.defeated },
          played: { ...row.played },
        };
      });
      return table;
    }

    function addWin(table, winner, loser) {
      const won = table[winner];
      const lost = table[loser];
      if (!won || !lost) return;
      won.w += 1;
      lost.l += 1;
      won.defeated[loser] = (won.defeated[loser] || 0) + 1;
      won.played[loser] = (won.played[loser] || 0) + 1;
      lost.played[winner] = (lost.played[winner] || 0) + 1;
      if (divisionOf[winner] && divisionOf[winner] === divisionOf[loser]) {
        won.dw += 1;
        lost.dl += 1;
      }
      if (conferenceOf[winner] && conferenceOf[winner] === conferenceOf[loser]) {
        won.cw += 1;
        lost.cl += 1;
      }
    }

    function rate(table) {
      const recordPct = (won, lost, tied) => {
        const games = won + lost + (tied || 0);
        return games ? (won + (tied || 0) * 0.5) / games : 0;
      };
      const winPct = {};
      teams.forEach((abbr) => {
        winPct[abbr] = recordPct(table[abbr].w, table[abbr].l, table[abbr].t);
      });
      const strength = (abbr, onlyWins) => {
        const row = table[abbr];
        const source = onlyWins ? row.defeated : row.played;
        let total = 0;
        let count = 0;
        Object.keys(source).forEach((opp) => {
          const times = source[opp] || 0;
          if (!times || winPct[opp] == null) return;
          total += times * winPct[opp];
          count += times;
        });
        return count ? total / count : 0;
      };
      const h2hApplies = (group) => {
        if (group.length < 2) return false;
        if (group.length === 2) return (table[group[0]].played[group[1]] || 0) > 0;
        const beatAll = group.some((team) => group.every((other) => other === team || (table[team].defeated[other] || 0) > (table[other].defeated[team] || 0)));
        if (beatAll) return true;
        return group.every((team) => group.every((other) => other === team || (table[team].played[other] || 0) > 0));
      };
      const h2h = (team, group) => {
        if (!h2hApplies(group)) return 0;
        let won = 0;
        let lost = 0;
        group.forEach((other) => {
          if (other === team) return;
          won += table[team].defeated[other] || 0;
          lost += table[other].defeated[team] || 0;
        });
        return recordPct(won, lost);
      };
      const common = (team, group) => {
        if (group.length < 2) return 0;
        const opponents = {};
        group.forEach((club) => {
          Object.keys(table[club].played).forEach((opp) => {
            if (group.includes(opp)) return;
            opponents[opp] = (opponents[opp] || 0) + 1;
          });
        });
        const shared = Object.keys(opponents).filter((opp) => opponents[opp] === group.length);
        const enough = group.every((club) => shared.reduce((count, opp) => count + (table[club].played[opp] || 0), 0) >= 4);
        if (!enough) return 0;
        let won = 0;
        let lost = 0;
        shared.forEach((opp) => {
          won += table[team].defeated[opp] || 0;
          lost += (table[team].played[opp] || 0) - (table[team].defeated[opp] || 0);
        });
        return recordPct(won, lost);
      };
      const stepsFor = (mode) => {
        const conferenceRecord = (team) => recordPct(table[team].cw, table[team].cl, table[team].ct);
        const divisionRecord = (team) => recordPct(table[team].dw, table[team].dl, table[team].dt);
        const pointScore = (team, ranksFor, ranksAgainst) => -((ranksFor[team] || 99) + (ranksAgainst[team] || 99));
        const net = (team) => {
          const record = records[team] || {};
          if (Number.isFinite(record.diff)) return record.diff;
          return (record.pointsFor || 0) - (record.pointsAgainst || 0);
        };
        const head = (team, group) => h2h(team, group);
        const shared = (team, group) => common(team, group);
        const victory = (team) => strength(team, true);
        const schedule = (team) => strength(team, false);
        const conferencePoints = (team) => pointScore(team, pfConf[conferenceOf[team]] || {}, paConf[conferenceOf[team]] || {});
        const leaguePoints = (team) => pointScore(team, pfLeague, paLeague);
        if (mode === "division") {
          return [head, divisionRecord, shared, conferenceRecord, victory, schedule, conferencePoints, leaguePoints, net];
        }
        return [head, conferenceRecord, shared, victory, schedule, conferencePoints, leaguePoints, net];
      };
      return { winPct, stepsFor, recordPct };
    }

    function play(home, away) {
      const probability = profiles ? homeProb(home, away, profiles, false) : 0.5;
      return random() < probability ? home : away;
    }

    function playNeutral(afc, nfc) {
      const probability = profiles ? homeProb(afc, nfc, profiles, true) : 0.5;
      return random() < probability ? afc : nfc;
    }

    (options.remaining || []).forEach((game) => {
      game.prob = profiles ? homeProb(game.home, game.away, profiles, game.neutral) : 0.5;
    });

    for (let sim = 0; sim < sims; sim += 1) {
      const table = cloneTable();
      (options.remaining || []).forEach((game) => {
        if (random() < game.prob) addWin(table, game.home, game.away);
        else addWin(table, game.away, game.home);
      });
      const rated = rate(table);
      const rankBy = (mode) => (group) => {
        if (mode === "wild" && group.length > 1 && group.every((team) => divisionOf[team] === divisionOf[group[0]])) {
          return rated.stepsFor("division");
        }
        return rated.stepsFor(mode);
      };
      ["AFC", "NFC"].forEach((conference) => {
        const groups = divisions.filter((division) => division.conference === conference);
        const winners = groups.map((division) => orderClubs(division.teams.slice(), rankBy("division"))[0]);
        const winnerRank = orderClubs(winners.slice(), rankBy("seed"));
        const wild = orderClubs(conferenceClubs(conference).filter((abbr) => !winners.includes(abbr)), rankBy("wild")).slice(0, 3);
        const seeds = winnerRank.concat(wild);
        const bracketKey = seeds.join(",");
        brackets[conference][bracketKey] = (brackets[conference][bracketKey] || 0) + 1;
        seeds.forEach((abbr, index) => {
          tally[abbr].seeds[index + 1] += 1;
          tally[abbr].playoff += 1;
        });
        winners.forEach((abbr) => {
          tally[abbr].division += 1;
        });
        const bye = seeds[0];
        const wildWinners = [
          play(seeds[1], seeds[6]),
          play(seeds[2], seeds[5]),
          play(seeds[3], seeds[4]),
        ];
        const rank = {};
        seeds.forEach((abbr, index) => {
          rank[abbr] = index + 1;
        });
        const alive = [bye].concat(wildWinners).sort((a, b) => rank[a] - rank[b]);
        const divisionWinners = [play(alive[0], alive[3]), play(alive[1], alive[2])];
        divisionWinners.forEach((abbr) => {
          tally[abbr].conference += 1;
        });
        const titlePair = divisionWinners.slice().sort((a, b) => rank[a] - rank[b]);
        const champion = play(titlePair[0], titlePair[1]);
        tally[champion].superBowl += 1;
        tally[champion].conferenceChampion = (tally[champion].conferenceChampion || 0) + 1;
        if (conference === "AFC") table.__afc = champion;
        else table.__nfc = champion;
      });
      const superBowlWinner = playNeutral(table.__afc, table.__nfc);
      if (tally[superBowlWinner]) tally[superBowlWinner].champion += 1;
    }

    const result = { sims, teams: {}, brackets: {} };
    ["AFC", "NFC"].forEach((conference) => {
      let best = "";
      let count = -1;
      Object.keys(brackets[conference]).forEach((key) => {
        if (brackets[conference][key] > count) {
          best = key;
          count = brackets[conference][key];
        }
      });
      result.brackets[conference] = best ? best.split(",") : [];
    });
    teams.forEach((abbr) => {
      const row = tally[abbr];
      let seed = 0;
      let seedCount = 0;
      for (let number = 1; number <= 7; number += 1) {
        if (row.seeds[number] > seedCount) {
          seed = number;
          seedCount = row.seeds[number];
        }
      }
      result.teams[abbr] = {
        division: row.division / sims,
        playoff: row.playoff / sims,
        conference: row.conference / sims,
        superBowl: row.superBowl / sims,
        champion: row.champion / sims,
        seed: row.playoff / sims >= 0.5 ? seed : 0,
        seedCounts: row.seeds.slice(1),
      };
    });
    return result;
  }

  function applyActual(saved, actual) {
    if (!actual) return saved;
    saved.actual = {
      homeScore: actual.homeScore,
      awayScore: actual.awayScore,
      winner: actual.winner,
    };
    return saved;
  }

  /**
   * started: kickoff has passed, or the game is live or final.
   * latest: a new projection, or null when the model cannot project yet.
   * actual: final score, or null.
   */
  function syncPrediction(store, game, latest, started, actual, now) {
    const predictions = store.predictions || (store.predictions = {});
    const saved = predictions[game.id];
    if (game.postponed) {
      const row = saved || { id: game.id, week: game.week, kickoffMs: game.kickoffMs, home: game.home, away: game.away };
      row.postponed = true;
      predictions[game.id] = row;
      return row;
    }
    if (saved && saved.frozen) {
      if (actual) applyActual(saved, actual);
      return saved;
    }
    if (started) {
      if (!saved) {
        const missing = {
          id: game.id,
          week: game.week,
          kickoffMs: game.kickoffMs,
          home: game.home,
          away: game.away,
          missing: true,
          frozen: true,
          frozenAt: now,
        };
        if (actual) applyActual(missing, actual);
        predictions[game.id] = missing;
        return missing;
      }
      saved.frozen = true;
      saved.frozenAt = saved.updatedAt || now;
      if (actual) applyActual(saved, actual);
      return saved;
    }
    if (!latest) return saved || null;
    const next = {
      id: game.id,
      week: game.week,
      kickoffMs: game.kickoffMs,
      home: game.home,
      away: game.away,
      neutral: Boolean(game.neutral),
      winner: latest.winner,
      homeScore: latest.homeScore,
      awayScore: latest.awayScore,
      homeWinProb: latest.homeWinProb,
      awayWinProb: latest.awayWinProb,
      confidence: latest.confidence,
      explanation: latest.explanation,
      recentHome: latest.recentHome,
      recentAway: latest.recentAway,
      frozen: false,
      updatedAt: now,
      actual: null,
    };
    if (saved && !saved.frozen && saved.winner === next.winner && saved.homeScore === next.homeScore && saved.awayScore === next.awayScore && saved.explanation === next.explanation) {
      return saved;
    }
    predictions[game.id] = next;
    return next;
  }

  function mergeStores(fileStore, localStore) {
    const merged = {
      season: (fileStore && fileStore.season) || (localStore && localStore.season) || null,
      model: "margin-v1",
      updatedAt: null,
      turnovers: { ...((fileStore && fileStore.turnovers) || {}), ...((localStore && localStore.turnovers) || {}) },
      turnoversAt: (localStore && localStore.turnoversAt) || (fileStore && fileStore.turnoversAt) || null,
      predictions: {},
      snapshots: {},
      roadHistory: [],
    };
    const ids = new Set([
      ...Object.keys((fileStore && fileStore.predictions) || {}),
      ...Object.keys((localStore && localStore.predictions) || {}),
    ]);
    ids.forEach((id) => {
      const copies = [fileStore && fileStore.predictions && fileStore.predictions[id], localStore && localStore.predictions && localStore.predictions[id]].filter(Boolean);
      const frozen = copies.filter((item) => item.frozen && !item.missing);
      if (frozen.length) {
        frozen.sort((a, b) => String(a.frozenAt || a.updatedAt || "").localeCompare(String(b.frozenAt || b.updatedAt || "")));
        const kept = { ...frozen[0] };
        copies.forEach((item) => {
          if (item.actual) kept.actual = item.actual;
        });
        merged.predictions[id] = kept;
        return;
      }
      copies.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
      merged.predictions[id] = { ...copies[copies.length - 1] };
    });
    const weeks = new Set([
      ...Object.keys((fileStore && fileStore.snapshots) || {}),
      ...Object.keys((localStore && localStore.snapshots) || {}),
    ]);
    weeks.forEach((week) => {
      const teams = {
        ...(((fileStore && fileStore.snapshots && fileStore.snapshots[week]) || {}).teams || {}),
      };
      const localTeams = (((localStore && localStore.snapshots && localStore.snapshots[week]) || {}).teams || {});
      Object.keys(localTeams).forEach((abbr) => {
        if (!teams[abbr]) teams[abbr] = localTeams[abbr];
      });
      merged.snapshots[week] = {
        savedAt: ((fileStore && fileStore.snapshots && fileStore.snapshots[week]) || {}).savedAt
          || ((localStore && localStore.snapshots && localStore.snapshots[week]) || {}).savedAt
          || null,
        teams,
      };
    });
    const roadHistory = [
      ...((fileStore && fileStore.roadHistory) || []),
      ...((localStore && localStore.roadHistory) || []),
    ];
    const seenRoad = new Set();
    merged.roadHistory = roadHistory.filter((entry) => {
      const key = `${entry && entry.week}|${entry && entry.finals}|${entry && entry.savedAt}`;
      if (seenRoad.has(key)) return false;
      seenRoad.add(key);
      return true;
    }).sort((a, b) => String(a.savedAt || "").localeCompare(String(b.savedAt || "")));
    const times = [fileStore && fileStore.updatedAt, localStore && localStore.updatedAt].filter(Boolean).sort();
    merged.updatedAt = times[times.length - 1] || null;
    return merged;
  }

  function graded(prediction) {
    return Boolean(prediction && prediction.frozen && !prediction.missing && !prediction.postponed && prediction.actual && prediction.winner);
  }

  function correct(prediction) {
    return graded(prediction) && prediction.winner === prediction.actual.winner;
  }

  function reseedDivisional(teams) {
    const alive = (teams || []).slice().sort((a, b) => a.seed - b.seed);
    if (alive.length !== 4 || alive.some((team) => !team || !team.abbr)) return null;
    return {
      top: { home: alive[0], away: alive[3] },
      bottom: { home: alive[1], away: alive[2] },
    };
  }

  function reseedChampionship(teams) {
    const alive = (teams || []).slice().sort((a, b) => a.seed - b.seed);
    if (alive.length !== 2 || alive.some((team) => !team || !team.abbr)) return null;
    return { home: alive[0], away: alive[1] };
  }

  function settledDivisional(bye, games) {
    function worlds(index, chosen) {
      if (index === games.length) return [chosen];
      const options = (games[index] && games[index].options) || [];
      return options.flatMap((team) => worlds(index + 1, chosen.concat([team])));
    }
    const list = worlds(0, []);
    if (!bye || !list.length) return { top: null, bottom: null };
    let top = null;
    let bottom = null;
    let topStable = true;
    let bottomStable = true;
    list.forEach((winners) => {
      const pairing = reseedDivisional([bye].concat(winners));
      if (!pairing) {
        topStable = false;
        bottomStable = false;
        return;
      }
      const away = pairing.top.away.abbr;
      const key = [pairing.bottom.home.abbr, pairing.bottom.away.abbr].slice().sort().join("|");
      if (!top) top = pairing.top;
      else if (top.away.abbr !== away) topStable = false;
      if (!bottom) bottom = pairing.bottom;
      else if ([bottom.home.abbr, bottom.away.abbr].slice().sort().join("|") !== key) bottomStable = false;
    });
    return {
      top: topStable ? top : null,
      bottom: bottomStable ? bottom : null,
    };
  }

  function selfCheck() {
    const errors = [];
    const three = sigmoid(3);
    if (three < 0.55 || three > 0.57) errors.push("A 3-point margin should be about 55.7%.");
    if (Math.abs(sigmoid(0) - 0.5) > 0.0001) errors.push("An even margin should be 50%.");
    const records = {
      AA: { wins: 8, losses: 0, ties: 0, pointsFor: 280, pointsAgainst: 120, summary: "8-0", diff: 160 },
      BB: { wins: 0, losses: 8, ties: 0, pointsFor: 120, pointsAgainst: 280, summary: "0-8", diff: -160 },
    };
    const index = buildIndex([]);
    const profiles = profilesFor(records, index, { AA: 4, BB: -4 });
    const pick = project("AA", "BB", profiles, true);
    if (!pick || pick.winner !== "AA" || pick.homeWinProb < 0.7) errors.push("The higher-scoring team should be favored on a neutral field.");
    const club = (seed) => ({ abbr: `S${seed}`, seed });
    const bye = club(1);
    const expectedSeeds = {
      "2,3,4": "1-4|2-3",
      "2,3,5": "1-5|2-3",
      "2,6,4": "1-6|2-4",
      "2,6,5": "1-6|2-5",
      "7,3,4": "1-7|3-4",
      "7,3,5": "1-7|3-5",
      "7,6,4": "1-7|4-6",
      "7,6,5": "1-7|5-6",
    };
    Object.keys(expectedSeeds).forEach((key) => {
      const winners = key.split(",").map((seed) => club(Number(seed)));
      const pairing = reseedDivisional([bye].concat(winners));
      const got = pairing ? `${pairing.top.home.seed}-${pairing.top.away.seed}|${pairing.bottom.home.seed}-${pairing.bottom.away.seed}` : "none";
      if (got !== expectedSeeds[key]) errors.push(`Wild-card winners ${key} should reseed to ${expectedSeeds[key]}, not ${got}.`);
      const settled = settledDivisional(bye, winners.map((team) => ({ options: [team] })));
      const settledText = settled.top && settled.bottom
        ? `${settled.top.home.seed}-${settled.top.away.seed}|${settled.bottom.home.seed}-${settled.bottom.away.seed}`
        : "none";
      if (settledText !== expectedSeeds[key]) errors.push(`Settled wild-card winners ${key} should reseed to ${expectedSeeds[key]}, not ${settledText}.`);
    });
    const sevenLocked = settledDivisional(bye, [
      { options: [club(7)] },
      { options: [club(3), club(6)] },
      { options: [club(4), club(5)] },
    ]);
    if (!sevenLocked.top || sevenLocked.top.away.seed !== 7 || sevenLocked.bottom) {
      errors.push("A 7-seed win should lock No. 1 against the 7 seed before the other wild-card games finish.");
    }
    const sixLocked = settledDivisional(bye, [
      { options: [club(2)] },
      { options: [club(6)] },
      { options: [club(4), club(5)] },
    ]);
    if (!sixLocked.top || sixLocked.top.away.seed !== 6 || sixLocked.bottom) {
      errors.push("Once the 7 seed is out and the 6 seed has won, No. 1 plays the 6 seed.");
    }
    const openField = settledDivisional(bye, [
      { options: [club(2), club(7)] },
      { options: [club(3), club(6)] },
      { options: [club(4), club(5)] },
    ]);
    if (openField.top || openField.bottom) errors.push("Divisional matchups should wait until the wild-card winners decide them.");
    const title = reseedChampionship([club(4), club(1)]);
    if (!title || title.home.seed !== 1 || title.away.seed !== 4) errors.push("The higher seed hosts the conference championship.");
    return { ok: errors.length === 0, errors, three };
  }

  global.Predict = {
    HOME_FIELD,
    LOGISTIC_SCALE,
    SIMS,
    readTurnover,
    buildIndex,
    profile,
    profilesFor,
    project,
    homeProb,
    expectedRemaining,
    playoffOdds,
    roadSim,
    reseedDivisional,
    reseedChampionship,
    settledDivisional,
    syncPrediction,
    mergeStores,
    graded,
    correct,
    selfCheck,
  };
})(window);
