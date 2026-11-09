#!/usr/bin/env python3
"""Refresh data/predictions/{season}.json from the public ESPN feeds.

The constants and freeze rule match js/predict.js (margin model v1).
ESPN's public NFL endpoints do not use an API key.
Run this on a schedule so projections update while the browser is closed.
Predictions are replaced only before kickoff. After kickoff the saved
prediction stays, and a later run can attach the final score.
"""

from __future__ import annotations

import json
import math
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME_FIELD = 2.5
LOGISTIC_SCALE = 13
SEASON_WEIGHT = 0.7
RECENT_WEIGHT = 0.3
TURNOVER_POINT = 0.7
SOS_SCALE = 6
H2H_BUMP = 0.5
ROOT = Path(__file__).resolve().parents[1]
IDS = {
    "ATL": "1", "BUF": "2", "CHI": "3", "CIN": "4", "CLE": "5", "DAL": "6", "DEN": "7", "DET": "8",
    "GB": "9", "TEN": "10", "IND": "11", "KC": "12", "LV": "13", "LAR": "14", "MIA": "15", "MIN": "16",
    "NE": "17", "NO": "18", "NYG": "19", "NYJ": "20", "PHI": "21", "ARI": "22", "PIT": "23", "LAC": "24",
    "SF": "25", "SEA": "26", "TB": "27", "WSH": "28", "CAR": "29", "JAX": "30", "BAL": "33", "HOU": "34",
}


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "NFLCountdown/1.0"})
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def norm(abbr):
    key = str(abbr or "").upper()
    return "WSH" if key == "WAS" else key


def number(value):
    if isinstance(value, bool) or value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    if isinstance(value, dict):
        if value.get("displayValue") not in (None, ""):
            try:
                return int(value["displayValue"])
            except ValueError:
                return None
        if isinstance(value.get("value"), (int, float)):
            return value["value"]
    return None


def stat(stats, name):
    found = next((item for item in stats or [] if item.get("name") == name), None)
    if not found:
        return None
    try:
        return float(found.get("value"))
    except (TypeError, ValueError):
        return None


def stat_text(stats, name):
    found = next((item for item in stats or [] if item.get("name") == name), None)
    return str(found.get("displayValue") or "") if found else ""


def postponed(status_type):
    name = f"{(status_type or {}).get('name', '')} {(status_type or {}).get('description', '')}".upper()
    return "POSTPONED" in name or "DELAYED" in name or "SUSPENDED" in name


def sigmoid(margin):
    return 1 / (1 + math.exp(-margin / LOGISTIC_SCALE))


def season_year(now):
    return now.year - 1 if now.month < 3 else now.year


def load_standings():
    payload = get_json("https://site.api.espn.com/apis/v2/sports/football/nfl/standings")
    records = {}
    for conference in payload.get("children") or []:
        entries = ((conference.get("standings") or {}).get("entries")) or []
        for entry in entries:
            stats = entry.get("stats") or []
            abbr = norm((entry.get("team") or {}).get("abbreviation"))
            wins = int(stat(stats, "wins") or 0)
            losses = int(stat(stats, "losses") or 0)
            ties = int(stat(stats, "ties") or 0)
            records[abbr] = {
                "wins": wins,
                "losses": losses,
                "ties": ties,
                "pointsFor": stat(stats, "pointsFor"),
                "pointsAgainst": stat(stats, "pointsAgainst"),
                "summary": stat_text(stats, "overall") or f"{wins}-{losses}" + (f"-{ties}" if ties else ""),
            }
    return records


def load_week(year, week):
    payload = get_json(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates={year}&seasontype=2&week={week}")
    games = []
    for event in payload.get("events") or []:
        competition = (event.get("competitions") or [None])[0]
        if not competition:
            continue
        status_type = ((competition.get("status") or event.get("status") or {}).get("type") or {})
        state = status_type.get("state")
        status = "in" if state == "in" else "post" if state == "post" or status_type.get("completed") else "pre"
        kickoff = datetime.fromisoformat(event["date"].replace("Z", "+00:00")).timestamp() * 1000
        home = away = None
        for comp in competition.get("competitors") or []:
            side = {"abbr": norm((comp.get("team") or {}).get("abbreviation")), "score": number(comp.get("score"))}
            if comp.get("homeAway") == "home":
                home = side
            else:
                away = side
        if not home or not away:
            continue
        games.append({
            "id": str(event.get("id")),
            "week": week,
            "kickoffMs": kickoff,
            "status": status,
            "postponed": postponed(status_type),
            "neutral": bool(competition.get("neutralSite")),
            "home": home["abbr"],
            "away": away["abbr"],
            "homeScore": home["score"],
            "awayScore": away["score"],
        })
    return games


def load_turnovers():
    found = {}
    for abbr, team_id in IDS.items():
        try:
            payload = get_json(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{team_id}/statistics")
            categories = (((payload.get("results") or {}).get("stats") or {}).get("categories") or [])
            misc = next((item for item in categories if item.get("name") == "miscellaneous"), None)
            stat_row = next((item for item in (misc or {}).get("stats") or [] if item.get("name") == "turnOverDifferential"), None)
            found[abbr] = float(stat_row["value"]) if stat_row and stat_row.get("value") not in (None, "") else None
        except Exception:
            found[abbr] = None
    return found


def build_index(games):
    by_team = {}
    meetings = {}
    for game in games:
        if game["status"] != "post" or game["homeScore"] is None or game["awayScore"] is None:
            continue
        home_score, away_score = game["homeScore"], game["awayScore"]
        winner = "TIE" if home_score == away_score else game["home"] if home_score > away_score else game["away"]
        pair = "-".join(sorted((game["home"], game["away"])))
        meetings.setdefault(pair, []).append({"kickoffMs": game["kickoffMs"], "winner": winner})
        for abbr, margin, result in (
            (game["home"], home_score - away_score, "T" if home_score == away_score else "W" if home_score > away_score else "L"),
            (game["away"], away_score - home_score, "T" if away_score == home_score else "W" if away_score > home_score else "L"),
        ):
            by_team.setdefault(abbr, []).append({"kickoffMs": game["kickoffMs"], "opponent": game["away"] if abbr == game["home"] else game["home"], "margin": margin, "result": result})
    for rows in by_team.values():
        rows.sort(key=lambda item: item["kickoffMs"])
    for rows in meetings.values():
        rows.sort(key=lambda item: item["kickoffMs"])
    return by_team, meetings


def profile(abbr, records, by_team, turnovers):
    record = records.get(abbr) or {}
    games = record.get("wins", 0) + record.get("losses", 0) + record.get("ties", 0)
    points_for, points_against = record.get("pointsFor"), record.get("pointsAgainst")
    recent = (by_team.get(abbr) or [])[-5:]
    ready = games > 0 and points_for is not None and points_against is not None
    season_margin = (points_for - points_against) / games if ready else 0
    recent_margin = sum(item["margin"] for item in recent) / len(recent) if recent else season_margin
    blended = SEASON_WEIGHT * season_margin + RECENT_WEIGHT * recent_margin if ready and len(recent) >= 3 else season_margin
    turnover = turnovers.get(abbr)
    turnover_points = (turnover / games) * TURNOVER_POINT if ready and turnover is not None else 0
    opponents = [records.get(item["opponent"]) for item in (by_team.get(abbr) or []) if records.get(item["opponent"])]
    if opponents:
        percents = []
        for item in opponents:
            played = item["wins"] + item["losses"] + item["ties"]
            percents.append(((item["wins"] + 0.5 * item["ties"]) / played) if played else 0.5)
        sos = sum(percents) / len(percents)
    else:
        sos = 0.5
    return {
        "ready": ready,
        "games": games,
        "record": record.get("summary") or "—",
        "ppg": points_for / games if ready else None,
        "papg": points_against / games if ready else None,
        "recent": [item["result"] for item in recent],
        "recentMargin": recent_margin,
        "turnover": turnover,
        "strength": blended + turnover_points - (sos - 0.5) * SOS_SCALE,
    }


def project(home, away, profiles, meetings, neutral):
    home_profile, away_profile = profiles.get(home), profiles.get(away)
    if not home_profile or not away_profile or not home_profile["ready"] or not away_profile["ready"]:
        return None
    last = (meetings.get("-".join(sorted((home, away)))) or [None])[-1]
    bump = 0 if not last or last["winner"] == "TIE" else H2H_BUMP if last["winner"] == home else -H2H_BUMP
    margin = home_profile["strength"] - away_profile["strength"] + (0 if neutral else HOME_FIELD) + bump
    prob = sigmoid(margin)
    total = (home_profile["ppg"] + away_profile["papg"]) / 2 + (away_profile["ppg"] + home_profile["papg"]) / 2
    home_score = max(0, round((total + margin) / 2))
    away_score = max(0, round((total - margin) / 2))
    if home_score == away_score and abs(prob - 0.5) >= 0.005:
        if prob > 0.5:
            home_score += 1
        else:
            away_score += 1
    winner = "TIE" if home_score == away_score else home if home_score > away_score else away
    edge = abs(prob - 0.5)
    sample = min(home_profile["games"], away_profile["games"])
    confidence = "Low" if sample < 3 or edge < 0.06 else "High" if edge >= 0.12 and sample >= 5 else "Medium"
    return {
        "winner": winner,
        "homeScore": home_score,
        "awayScore": away_score,
        "homeWinProb": prob,
        "awayWinProb": 1 - prob,
        "confidence": confidence,
        "recentHome": home_profile["recent"],
        "recentAway": away_profile["recent"],
        "explanation": (
            f"{home} is {home_profile['record']}, scoring {home_profile['ppg']:.1f} and allowing {home_profile['papg']:.1f} points per game. "
            f"{away} is {away_profile['record']}, scoring {away_profile['ppg']:.1f} and allowing {away_profile['papg']:.1f}. "
            f"Projected margin {margin:.1f} points, {(prob * 100):.0f}% for {home}."
        ),
    }


def sync(store, game, latest, now_ms, now_iso):
    predictions = store.setdefault("predictions", {})
    saved = predictions.get(game["id"])
    started = game["postponed"] or game["kickoffMs"] <= now_ms or game["status"] in ("in", "post")
    actual = None
    if game["status"] == "post" and not game["postponed"] and game["homeScore"] is not None and game["awayScore"] is not None:
        actual = {
            "homeScore": game["homeScore"],
            "awayScore": game["awayScore"],
            "winner": "TIE" if game["homeScore"] == game["awayScore"] else game["home"] if game["homeScore"] > game["awayScore"] else game["away"],
        }
    if game["postponed"]:
        row = saved or {"id": game["id"], "week": game["week"], "kickoffMs": game["kickoffMs"], "home": game["home"], "away": game["away"]}
        row["postponed"] = True
        predictions[game["id"]] = row
        return
    if saved and saved.get("frozen"):
        if actual:
            saved["actual"] = actual
        return
    if started:
        if not saved:
            missing = {"id": game["id"], "week": game["week"], "kickoffMs": game["kickoffMs"], "home": game["home"], "away": game["away"], "missing": True, "frozen": True, "frozenAt": now_iso}
            if actual:
                missing["actual"] = actual
            predictions[game["id"]] = missing
            return
        saved["frozen"] = True
        saved["frozenAt"] = saved.get("updatedAt") or now_iso
        if actual:
            saved["actual"] = actual
        return
    if not latest:
        return
    current = predictions.get(game["id"])
    if current and not current.get("frozen") and current.get("winner") == latest["winner"] and current.get("homeScore") == latest["homeScore"] and current.get("awayScore") == latest["awayScore"] and current.get("explanation") == latest["explanation"]:
        return
    predictions[game["id"]] = {
        "id": game["id"], "week": game["week"], "kickoffMs": game["kickoffMs"], "home": game["home"], "away": game["away"],
        "neutral": game["neutral"], **latest, "frozen": False, "updatedAt": now_iso, "actual": None,
    }


def main():
    now = datetime.now(timezone.utc)
    year = season_year(now)
    path = ROOT / "data" / "predictions" / f"{year}.json"
    store = {"season": year, "model": "margin-v1", "predictions": {}, "turnovers": {}, "snapshots": {}, "updatedAt": None}
    if path.exists():
        store.update(json.loads(path.read_text()))
        store.setdefault("predictions", {})
        store.setdefault("snapshots", {})
    records = load_standings()
    games = []
    for week in range(1, 19):
        games.extend(load_week(year, week))
    turnovers = load_turnovers()
    store["turnovers"] = turnovers
    store["turnoversAt"] = now.isoformat()
    by_team, meetings = build_index(games)
    profiles = {abbr: profile(abbr, records, by_team, turnovers) for abbr in records}
    now_ms = now.timestamp() * 1000
    for game in games:
        latest = None if game["kickoffMs"] <= now_ms or game["status"] != "pre" else project(game["home"], game["away"], profiles, meetings, game["neutral"])
        sync(store, game, latest, now_ms, now.isoformat())
    store["updatedAt"] = now.isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2) + "\n")
    frozen = sum(1 for item in store["predictions"].values() if item.get("frozen") and not item.get("missing"))
    print(f"Saved {path} with {len(store['predictions'])} games, {frozen} frozen predictions.")


if __name__ == "__main__":
    main()
