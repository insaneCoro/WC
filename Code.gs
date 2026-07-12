
/******************************************************************
* ⚽ WC '26 PREDICTION LEAGUE — SERVER (Google Apps Script)
* Refined version with:
* - Chronological match order in GMT+3
* - Auto-save support through client
* - Odds tab from participant predictions
* - Bilingual Arabic/English UI support
* - API results sync with admin manual edit
* - New knockout scoring + penalty shootout prediction
******************************************************************/
function doGet(e) {
  // All API calls come in as GET with ?fn=name&args=base64encodedJSON
  // GET requests follow Google's redirect correctly; POST does not.
  var fn = e && e.parameter && e.parameter.fn;
  if (!fn) {
    return ContentService.createTextOutput(
      JSON.stringify({status:'ok', message:'WC26 API running'})
    ).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var args = [];
    if (e.parameter.args) {
      args = JSON.parse(Utilities.newBlob(
        Utilities.base64Decode(e.parameter.args)
      ).getDataAsString());
    }
    var allowed = {
      setupLeague:1,getState:1,login:1,savePreds:1,
      getLeaderboard:1,getOdds:1,
      adminLogin:1,adminSavePlayers:1,adminResetPin:1,adminRenamePlayer:1,
      adminForcePin:1,adminClearPlayerPreds:1,adminSaveKO:1,
      adminSaveResults:1,adminDeleteResult:1,adminGetPredictions:1,adminGetIncompleteKODraws:1,
      adminGetAllPredictions:1,adminGetFullMatrix:1,adminResetLeague:1,
      setFootballDataToken:1,getApiSyncStatus:1,syncFootballData:1,
      enableAutoSync:1,disableAutoSync:1,
      saveChampionPick:1,adminSetChampionWinner:1,getChampionLeaderboard:1,
      placeBet:1,cancelBet:1,getBettingState:1,getBettingLeaderboard:1,adminSettleBet:1,adminGetBets:1,
      adminAdjustPoints:1,adminDeleteAdjustment:1,adminGetAdjustments:1,adminDebugSync:1,
      adminGetHiddenTabs:1,adminSetHiddenTabs:1,adminGetChampionPicks:1,adminGetPredVisibility:1,adminSetPredVisibility:1,saveLeaderMessage:1,getLeaderMessage:1,
      adminGetResultLocks:1,adminSetResultLocks:1,adminRebuildBoard:1,adminClearKOTeams:1,
      adminForceCancelBet:1,adminSetBetPayout:1,adminPlaceBet:1,adminUnsettleBet:1,
      getAppVersion:1,adminBumpAppVersion:1,
      getLive:1
    };
    if (!allowed[fn]) throw new Error('Unknown function: ' + fn);
    var result = this[fn].apply(this, args);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(
      JSON.stringify({ok:false, msg: err.message || String(err)})
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
// API dispatcher — called by the GitHub Pages client via fetch().
// Client sends POST with Content-Type: text/plain (avoids CORS preflight).
// Body is JSON text: {fn: "functionName", args: [...]}.
// Apps Script automatically adds CORS headers for simple requests.
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var fn = body.fn, args = body.args || [];
    // Keep this list identical to the one in doGet so both transports expose
    // exactly the same functions.
    var allowed = {
      setupLeague:1,getState:1,login:1,savePreds:1,
      getLeaderboard:1,getOdds:1,
      adminLogin:1,adminSavePlayers:1,adminResetPin:1,adminRenamePlayer:1,
      adminForcePin:1,adminClearPlayerPreds:1,adminSaveKO:1,
      adminSaveResults:1,adminDeleteResult:1,adminGetPredictions:1,adminGetIncompleteKODraws:1,
      adminGetAllPredictions:1,adminGetFullMatrix:1,adminResetLeague:1,
      setFootballDataToken:1,getApiSyncStatus:1,syncFootballData:1,
      enableAutoSync:1,disableAutoSync:1,
      saveChampionPick:1,adminSetChampionWinner:1,getChampionLeaderboard:1,
      placeBet:1,cancelBet:1,getBettingState:1,getBettingLeaderboard:1,adminSettleBet:1,adminGetBets:1,
      adminAdjustPoints:1,adminDeleteAdjustment:1,adminGetAdjustments:1,adminDebugSync:1,
      adminGetHiddenTabs:1,adminSetHiddenTabs:1,adminGetChampionPicks:1,adminGetPredVisibility:1,adminSetPredVisibility:1,saveLeaderMessage:1,getLeaderMessage:1,
      adminGetResultLocks:1,adminSetResultLocks:1,adminRebuildBoard:1,adminClearKOTeams:1,
      adminForceCancelBet:1,adminSetBetPayout:1,adminPlaceBet:1,adminUnsettleBet:1,
      getAppVersion:1,adminBumpAppVersion:1,
      getLive:1
    };
    if (!fn || !allowed[fn]) throw new Error('Unknown function: ' + fn);
    var result = this[fn].apply(this, args);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(
      JSON.stringify({ok:false, msg: err.message || String(err)})
    ).setMimeType(ContentService.MimeType.JSON);
  }
}


var LOCK_MS = 5 * 60 * 1000;
var CHAMPION_LOCK_ISO = '2026-06-19T23:59:00+03:00';   // EARLY pick locks end of June 19 Riyadh
var CHAMPION_SWITCH_ISO = '2026-07-04T19:55:00+03:00'; // one-time switch locks 5 min before first R16
var CHAMPION_BONUS_EARLY = 20;     // correct champion picked & kept from before the early lock
var CHAMPION_BONUS_SWITCHED = 10;  // correct champion after using the one-time switch
var CHAMPION_MISS_PENALTY = 0;     // wrong champion (0 = no penalty)
var HIDE_ODDS_UNTIL_LOCK = false; // odds always visible — live crowd trajectory

// Scoring rules — enforced by _scoreOne(). (Matches the player-facing Rules tab.)
// Exact score:           Group +2 | R32 +6 | R16 +8 | QF +12 | SF +20 | 3rd +20 | Final +32
// Correct winner/draw:   Group +1 | R32 +3 | R16 +4 | QF +6  | SF +10 | 3rd +10 | Final +16
// Wrong pick:            Group  0 | R32 -3 | R16 -4 | QF -6  | SF -10 | 3rd -10 | Final -16
function _scoreValues(stage, matchNo) {
  var s = String(stage || '').toLowerCase();
  var no = Number(matchNo || 0);

  if (/^group/.test(s) || (no >= 1 && no <= 72)) return { exact: 2, outcome: 1, wrong: 0 };
  if (/round of 32|r32|last 32/.test(s) || (no >= 73 && no <= 88)) return { exact: 6, outcome: 3, wrong: -3 };
  if (/round of 16|r16|last 16/.test(s) || (no >= 89 && no <= 96)) return { exact: 8, outcome: 4, wrong: -4 };
  if (/quarter|qf/.test(s) || (no >= 97 && no <= 100)) return { exact: 12, outcome: 6, wrong: -6 };
  if (/third|3rd/.test(s) || no === 103) return { exact: 20, outcome: 10, wrong: -10 };
  if (/semi|sf/.test(s) || (no >= 101 && no <= 102)) return { exact: 20, outcome: 10, wrong: -10 };
  if ((/final/.test(s) && !/third|3rd/.test(s)) || no === 104) return { exact: 32, outcome: 16, wrong: -16 };

  // Safer default for unknown knockout labels: treat as R32/R16, not as group.
  return { exact: 4, outcome: 2, wrong: -2 };
}

var MATCHES = [
  { no: 1, fifaNo: 1, group: 'A', stage: 'Group A', h: 'Mexico', a: 'South Africa', iso: '2026-06-11T22:00:00+03:00' },
  { no: 2, fifaNo: 2, group: 'A', stage: 'Group A', h: 'South Korea', a: 'Czechia', iso: '2026-06-12T05:00:00+03:00' },
  { no: 3, fifaNo: 3, group: 'B', stage: 'Group B', h: 'Canada', a: 'Bosnia and Herzegovina', iso: '2026-06-12T22:00:00+03:00' },
  { no: 4, fifaNo: 4, group: 'D', stage: 'Group D', h: 'United States', a: 'Paraguay', iso: '2026-06-13T04:00:00+03:00' },
  { no: 5, fifaNo: 8, group: 'B', stage: 'Group B', h: 'Qatar', a: 'Switzerland', iso: '2026-06-13T22:00:00+03:00' },
  { no: 6, fifaNo: 7, group: 'C', stage: 'Group C', h: 'Brazil', a: 'Morocco', iso: '2026-06-14T01:00:00+03:00' },
  { no: 7, fifaNo: 5, group: 'C', stage: 'Group C', h: 'Haiti', a: 'Scotland', iso: '2026-06-14T04:00:00+03:00' },
  { no: 8, fifaNo: 6, group: 'D', stage: 'Group D', h: 'Australia', a: 'Türkiye', iso: '2026-06-14T07:00:00+03:00' },
  { no: 9, fifaNo: 10, group: 'E', stage: 'Group E', h: 'Germany', a: 'Curaçao', iso: '2026-06-14T20:00:00+03:00' },
  { no: 10, fifaNo: 11, group: 'F', stage: 'Group F', h: 'Netherlands', a: 'Japan', iso: '2026-06-14T23:00:00+03:00' },
  { no: 11, fifaNo: 9, group: 'E', stage: 'Group E', h: 'Côte d’Ivoire', a: 'Ecuador', iso: '2026-06-15T02:00:00+03:00' },
  { no: 12, fifaNo: 12, group: 'F', stage: 'Group F', h: 'Sweden', a: 'Tunisia', iso: '2026-06-15T05:00:00+03:00' },
  { no: 13, fifaNo: 14, group: 'H', stage: 'Group H', h: 'Spain', a: 'Cabo Verde', iso: '2026-06-15T19:00:00+03:00' },
  { no: 14, fifaNo: 16, group: 'G', stage: 'Group G', h: 'Belgium', a: 'Egypt', iso: '2026-06-15T22:00:00+03:00' },
  { no: 15, fifaNo: 13, group: 'H', stage: 'Group H', h: 'Saudi Arabia', a: 'Uruguay', iso: '2026-06-16T01:00:00+03:00' },
  { no: 16, fifaNo: 15, group: 'G', stage: 'Group G', h: 'IR Iran', a: 'New Zealand', iso: '2026-06-16T04:00:00+03:00' },
  { no: 17, fifaNo: 17, group: 'I', stage: 'Group I', h: 'France', a: 'Senegal', iso: '2026-06-16T22:00:00+03:00' },
  { no: 18, fifaNo: 18, group: 'I', stage: 'Group I', h: 'Iraq', a: 'Norway', iso: '2026-06-17T01:00:00+03:00' },
  { no: 19, fifaNo: 19, group: 'J', stage: 'Group J', h: 'Argentina', a: 'Algeria', iso: '2026-06-17T04:00:00+03:00' },
  { no: 20, fifaNo: 20, group: 'J', stage: 'Group J', h: 'Austria', a: 'Jordan', iso: '2026-06-17T07:00:00+03:00' },
  { no: 21, fifaNo: 23, group: 'K', stage: 'Group K', h: 'Portugal', a: 'Congo DR', iso: '2026-06-17T20:00:00+03:00' },
  { no: 22, fifaNo: 22, group: 'L', stage: 'Group L', h: 'England', a: 'Croatia', iso: '2026-06-17T23:00:00+03:00' },
  { no: 23, fifaNo: 21, group: 'L', stage: 'Group L', h: 'Ghana', a: 'Panama', iso: '2026-06-18T02:00:00+03:00' },
  { no: 24, fifaNo: 24, group: 'K', stage: 'Group K', h: 'Uzbekistan', a: 'Colombia', iso: '2026-06-18T05:00:00+03:00' },
  { no: 25, fifaNo: 25, group: 'A', stage: 'Group A', h: 'Czechia', a: 'South Africa', iso: '2026-06-18T19:00:00+03:00' },
  { no: 26, fifaNo: 26, group: 'B', stage: 'Group B', h: 'Switzerland', a: 'Bosnia and Herzegovina', iso: '2026-06-18T22:00:00+03:00' },
  { no: 27, fifaNo: 27, group: 'B', stage: 'Group B', h: 'Canada', a: 'Qatar', iso: '2026-06-19T01:00:00+03:00' },
  { no: 28, fifaNo: 28, group: 'A', stage: 'Group A', h: 'Mexico', a: 'South Korea', iso: '2026-06-19T04:00:00+03:00' },
  { no: 29, fifaNo: 32, group: 'D', stage: 'Group D', h: 'United States', a: 'Australia', iso: '2026-06-19T22:00:00+03:00' },
  { no: 30, fifaNo: 30, group: 'C', stage: 'Group C', h: 'Scotland', a: 'Morocco', iso: '2026-06-20T01:00:00+03:00' },
  { no: 31, fifaNo: 29, group: 'C', stage: 'Group C', h: 'Brazil', a: 'Haiti', iso: '2026-06-20T03:30:00+03:00' },
  { no: 32, fifaNo: 31, group: 'D', stage: 'Group D', h: 'Türkiye', a: 'Paraguay', iso: '2026-06-20T06:00:00+03:00' },
  { no: 33, fifaNo: 35, group: 'F', stage: 'Group F', h: 'Netherlands', a: 'Sweden', iso: '2026-06-20T20:00:00+03:00' },
  { no: 34, fifaNo: 33, group: 'E', stage: 'Group E', h: 'Germany', a: 'Côte d’Ivoire', iso: '2026-06-20T23:00:00+03:00' },
  { no: 35, fifaNo: 34, group: 'E', stage: 'Group E', h: 'Ecuador', a: 'Curaçao', iso: '2026-06-21T03:00:00+03:00' },
  { no: 36, fifaNo: 36, group: 'F', stage: 'Group F', h: 'Tunisia', a: 'Japan', iso: '2026-06-21T07:00:00+03:00' },
  { no: 37, fifaNo: 38, group: 'H', stage: 'Group H', h: 'Spain', a: 'Saudi Arabia', iso: '2026-06-21T19:00:00+03:00' },
  { no: 38, fifaNo: 39, group: 'G', stage: 'Group G', h: 'Belgium', a: 'IR Iran', iso: '2026-06-21T22:00:00+03:00' },
  { no: 39, fifaNo: 37, group: 'H', stage: 'Group H', h: 'Uruguay', a: 'Cabo Verde', iso: '2026-06-22T01:00:00+03:00' },
  { no: 40, fifaNo: 40, group: 'G', stage: 'Group G', h: 'New Zealand', a: 'Egypt', iso: '2026-06-22T04:00:00+03:00' },
  { no: 41, fifaNo: 43, group: 'J', stage: 'Group J', h: 'Argentina', a: 'Austria', iso: '2026-06-22T20:00:00+03:00' },
  { no: 42, fifaNo: 42, group: 'I', stage: 'Group I', h: 'France', a: 'Iraq', iso: '2026-06-23T00:00:00+03:00' },
  { no: 43, fifaNo: 41, group: 'I', stage: 'Group I', h: 'Norway', a: 'Senegal', iso: '2026-06-23T03:00:00+03:00' },
  { no: 44, fifaNo: 44, group: 'J', stage: 'Group J', h: 'Jordan', a: 'Algeria', iso: '2026-06-23T06:00:00+03:00' },
  { no: 45, fifaNo: 47, group: 'K', stage: 'Group K', h: 'Portugal', a: 'Uzbekistan', iso: '2026-06-23T20:00:00+03:00' },
  { no: 46, fifaNo: 45, group: 'L', stage: 'Group L', h: 'England', a: 'Ghana', iso: '2026-06-23T23:00:00+03:00' },
  { no: 47, fifaNo: 46, group: 'L', stage: 'Group L', h: 'Panama', a: 'Croatia', iso: '2026-06-24T02:00:00+03:00' },
  { no: 48, fifaNo: 48, group: 'K', stage: 'Group K', h: 'Colombia', a: 'Congo DR', iso: '2026-06-24T05:00:00+03:00' },
  { no: 49, fifaNo: 51, group: 'B', stage: 'Group B', h: 'Switzerland', a: 'Canada', iso: '2026-06-24T22:00:00+03:00' },
  { no: 50, fifaNo: 52, group: 'B', stage: 'Group B', h: 'Bosnia and Herzegovina', a: 'Qatar', iso: '2026-06-24T22:00:00+03:00' },
  { no: 51, fifaNo: 49, group: 'C', stage: 'Group C', h: 'Scotland', a: 'Brazil', iso: '2026-06-25T01:00:00+03:00' },
  { no: 52, fifaNo: 50, group: 'C', stage: 'Group C', h: 'Morocco', a: 'Haiti', iso: '2026-06-25T01:00:00+03:00' },
  { no: 53, fifaNo: 53, group: 'A', stage: 'Group A', h: 'Czechia', a: 'Mexico', iso: '2026-06-25T04:00:00+03:00' },
  { no: 54, fifaNo: 54, group: 'A', stage: 'Group A', h: 'South Africa', a: 'South Korea', iso: '2026-06-25T04:00:00+03:00' },
  { no: 55, fifaNo: 55, group: 'E', stage: 'Group E', h: 'Curaçao', a: 'Côte d’Ivoire', iso: '2026-06-25T23:00:00+03:00' },
  { no: 56, fifaNo: 56, group: 'E', stage: 'Group E', h: 'Ecuador', a: 'Germany', iso: '2026-06-25T23:00:00+03:00' },
  { no: 57, fifaNo: 57, group: 'F', stage: 'Group F', h: 'Japan', a: 'Sweden', iso: '2026-06-26T02:00:00+03:00' },
  { no: 58, fifaNo: 58, group: 'F', stage: 'Group F', h: 'Tunisia', a: 'Netherlands', iso: '2026-06-26T02:00:00+03:00' },
  { no: 59, fifaNo: 59, group: 'D', stage: 'Group D', h: 'Türkiye', a: 'United States', iso: '2026-06-26T05:00:00+03:00' },
  { no: 60, fifaNo: 60, group: 'D', stage: 'Group D', h: 'Paraguay', a: 'Australia', iso: '2026-06-26T05:00:00+03:00' },
  { no: 61, fifaNo: 61, group: 'I', stage: 'Group I', h: 'Norway', a: 'France', iso: '2026-06-26T22:00:00+03:00' },
  { no: 62, fifaNo: 62, group: 'I', stage: 'Group I', h: 'Senegal', a: 'Iraq', iso: '2026-06-26T22:00:00+03:00' },
  { no: 63, fifaNo: 65, group: 'H', stage: 'Group H', h: 'Cabo Verde', a: 'Saudi Arabia', iso: '2026-06-27T03:00:00+03:00' },
  { no: 64, fifaNo: 66, group: 'H', stage: 'Group H', h: 'Uruguay', a: 'Spain', iso: '2026-06-27T03:00:00+03:00' },
  { no: 65, fifaNo: 63, group: 'G', stage: 'Group G', h: 'Egypt', a: 'IR Iran', iso: '2026-06-27T06:00:00+03:00' },
  { no: 66, fifaNo: 64, group: 'G', stage: 'Group G', h: 'New Zealand', a: 'Belgium', iso: '2026-06-27T06:00:00+03:00' },
  { no: 67, fifaNo: 67, group: 'L', stage: 'Group L', h: 'Panama', a: 'England', iso: '2026-06-28T00:00:00+03:00' },
  { no: 68, fifaNo: 68, group: 'L', stage: 'Group L', h: 'Croatia', a: 'Ghana', iso: '2026-06-28T00:00:00+03:00' },
  { no: 69, fifaNo: 71, group: 'K', stage: 'Group K', h: 'Colombia', a: 'Portugal', iso: '2026-06-28T02:30:00+03:00' },
  { no: 70, fifaNo: 72, group: 'K', stage: 'Group K', h: 'Congo DR', a: 'Uzbekistan', iso: '2026-06-28T02:30:00+03:00' },
  { no: 71, fifaNo: 69, group: 'J', stage: 'Group J', h: 'Algeria', a: 'Austria', iso: '2026-06-28T05:00:00+03:00' },
  { no: 72, fifaNo: 70, group: 'J', stage: 'Group J', h: 'Jordan', a: 'Argentina', iso: '2026-06-28T05:00:00+03:00' },
  { no: 73, fifaNo: 73, stage: 'Round of 32', h: '2A',    a: '2B',    iso: '2026-06-28T22:00:00+03:00' },
  { no: 74, fifaNo: 74, stage: 'Round of 32', h: '1E',    a: '3ABCDF',iso: '2026-06-29T23:30:00+03:00' },
  { no: 75, fifaNo: 75, stage: 'Round of 32', h: '1F',    a: '2C',    iso: '2026-06-30T04:00:00+03:00' },
  { no: 76, fifaNo: 76, stage: 'Round of 32', h: '1C',    a: '2F',    iso: '2026-06-29T20:00:00+03:00' },
  { no: 77, fifaNo: 77, stage: 'Round of 32', h: '1I',    a: '3CDFGH',iso: '2026-07-01T00:00:00+03:00' },
  { no: 78, fifaNo: 78, stage: 'Round of 32', h: '2E',    a: '2I',    iso: '2026-06-30T20:00:00+03:00' },
  { no: 79, fifaNo: 79, stage: 'Round of 32', h: '1A',    a: '3CEFHI',iso: '2026-07-01T04:00:00+03:00' },
  { no: 80, fifaNo: 80, stage: 'Round of 32', h: '1L',    a: '3EHIJK',iso: '2026-07-01T19:00:00+03:00' },
  { no: 81, fifaNo: 81, stage: 'Round of 32', h: '1D',    a: '3BEFIJ',iso: '2026-07-02T03:00:00+03:00' },
  { no: 82, fifaNo: 82, stage: 'Round of 32', h: '1G',    a: '3AEHIJ',iso: '2026-07-01T23:00:00+03:00' },
  { no: 83, fifaNo: 83, stage: 'Round of 32', h: '2K',    a: '2L',    iso: '2026-07-03T02:00:00+03:00' },
  { no: 84, fifaNo: 84, stage: 'Round of 32', h: '1H',    a: '2J',    iso: '2026-07-02T22:00:00+03:00' },
  { no: 85, fifaNo: 85, stage: 'Round of 32', h: '1B',    a: '3EFGIJ',iso: '2026-07-03T06:00:00+03:00' },
  { no: 86, fifaNo: 86, stage: 'Round of 32', h: '1J',    a: '2H',    iso: '2026-07-04T01:00:00+03:00' },
  { no: 87, fifaNo: 87, stage: 'Round of 32', h: '1K',    a: '3DEIJL',iso: '2026-07-04T04:30:00+03:00' },
  { no: 88, fifaNo: 88, stage: 'Round of 32', h: '2D',    a: '2G',    iso: '2026-07-03T21:00:00+03:00' },
  { no: 89, fifaNo: 89, stage: 'Round of 16', h: 'W74',   a: 'W77',   iso: '2026-07-05T00:00:00+03:00' },
  { no: 90, fifaNo: 90, stage: 'Round of 16', h: 'W73',   a: 'W75',   iso: '2026-07-04T20:00:00+03:00' },
  { no: 91, fifaNo: 91, stage: 'Round of 16', h: 'W76',   a: 'W78',   iso: '2026-07-05T23:00:00+03:00' },
  { no: 92, fifaNo: 92, stage: 'Round of 16', h: 'W79',   a: 'W80',   iso: '2026-07-06T03:00:00+03:00' },
  { no: 93, fifaNo: 93, stage: 'Round of 16', h: 'W83',   a: 'W84',   iso: '2026-07-06T22:00:00+03:00' },
  { no: 94, fifaNo: 94, stage: 'Round of 16', h: 'W81',   a: 'W82',   iso: '2026-07-07T03:00:00+03:00' },
  { no: 95, fifaNo: 95, stage: 'Round of 16', h: 'W86',   a: 'W88',   iso: '2026-07-07T19:00:00+03:00' },
  { no: 96, fifaNo: 96, stage: 'Round of 16', h: 'W85',   a: 'W87',   iso: '2026-07-07T23:00:00+03:00' },
  { no: 97, fifaNo: 97, stage: 'Quarter-final', h: 'W89', a: 'W90', iso: '2026-07-09T23:00:00+03:00' },
  { no: 98, fifaNo: 98, stage: 'Quarter-final', h: 'W93', a: 'W94', iso: '2026-07-10T22:00:00+03:00' },
  { no: 99, fifaNo: 99, stage: 'Quarter-final', h: 'W91', a: 'W92', iso: '2026-07-12T00:00:00+03:00' },
  { no: 100, fifaNo: 100, stage: 'Quarter-final', h: 'W95', a: 'W96', iso: '2026-07-12T04:00:00+03:00' },
  { no: 101, fifaNo: 101, stage: 'Semi-final', h: 'W97', a: 'W98', iso: '2026-07-14T22:00:00+03:00' },
  { no: 102, fifaNo: 102, stage: 'Semi-final', h: 'W99', a: 'W100', iso: '2026-07-15T22:00:00+03:00' },
  { no: 103, fifaNo: 103, stage: 'Third-place play-off', h: 'L101', a: 'L102', iso: '2026-07-19T00:00:00+03:00' },
  { no: 104, fifaNo: 104, stage: 'Final', h: 'W101', a: 'W102', iso: '2026-07-19T22:00:00+03:00' }
];

// ── Lightweight cache layer (CacheService) ──
function _cache(){ return CacheService.getScriptCache(); }
function _cacheBust(){ try{ _cache().removeAll(['odds_v2','odds_v3_active','odds_v3_all','odds_v4_active','odds_v4_all','odds_v5_current','odds_v5_completed','board_v1','board_v2','pools_v1','results_v1','state_anon_v1']); }catch(e){} }

// Result completion timestamps drive the six-hour "recent result" window in
// Predictions, Odds, and Betting. Existing historical results fall back to an
// estimated finish time derived from kickoff.
var RECENT_RESULT_MS = 6 * 60 * 60 * 1000;
function _readResultFinishedTimes_(){
  try{ var raw=_props().getProperty('RESULT_FINISHED_AT'); return raw?JSON.parse(raw):{}; }
  catch(e){ return {}; }
}
function _writeResultFinishedTimes_(map){
  try{ _props().setProperty('RESULT_FINISHED_AT',JSON.stringify(map||{})); }catch(e){}
}
function _resultFinishedAt_(m,times){
  var saved=Number(times&&times[m.no]); if(saved>0)return saved;
  var kickoff=new Date(m&&m.iso||'').getTime();
  return isNaN(kickoff)?0:kickoff+(3*60*60*1000); // legacy-result fallback
}
function _showResultOnMain_(m,times,now){
  if(Number(m&&m.no)===104)return true; // Final remains permanently featured
  var finished=_resultFinishedAt_(m,times);
  return finished>0 && now < finished+RECENT_RESULT_MS;
}

// ── Precomputed leaderboard snapshot ──────────────────────────────────────
// The main leaderboard is expensive (it scores every player's picks against
// every result, plus bets/adjustments/champion). It only changes when results,
// bets, adjustments, the champion winner, or the roster change — never when a
// player merely views it or saves a future pick. So we compute it once per
// change and serve a stored snapshot to everyone else.
//
// _boardTouch_() bumps a version stamp on every change (cheap, one property
// write). getLeaderboard() rebuilds only when the snapshot's version is stale
// (or, as a safety net against a missed touch, when it's older than 10 min).
function _boardTouch_(){ try{ _props().setProperty('BOARD_VER', String(Date.now())); }catch(e){} }
function _boardVer_(){ return String(_props().getProperty('BOARD_VER')||'0'); }
function _boardStore_(payload){
  var json=JSON.stringify(payload);
  try{ _cache().put('board_v2', json, 21600); }catch(e){}              // 6h fast layer
  try{ if(json.length<9000) _props().setProperty('BOARD_SNAP', json); else _props().deleteProperty('BOARD_SNAP'); }catch(e){} // durable backstop
}
function _boardRead_(){
  var j=null; try{ j=_cache().get('board_v2'); }catch(e){}
  if(!j){ try{ j=_props().getProperty('BOARD_SNAP'); }catch(e){} if(j){ try{ _cache().put('board_v2', j, 21600); }catch(e){} } }
  if(!j) return null; try{ return JSON.parse(j); }catch(e){ return null; }
}

function _props(){ return PropertiesService.getScriptProperties(); }


// ── App version / update banner support ──
// Stored in Script Properties so future updates do not require editing version
// numbers in multiple files. Use Admin → API Sync → Bump app version after
// deploying an update that players should refresh for.
var DEFAULT_APP_VERSION = 2026062701;
function _appVersion_(){
  var v = Number(PropertiesService.getScriptProperties().getProperty('APP_VERSION') || DEFAULT_APP_VERSION);
  return v || DEFAULT_APP_VERSION;
}
function getAppVersion(){
  return {
    ok: true,
    version: _appVersion_(),
    message: 'New tournament update available. Please refresh or reopen the app.'
  };
}
function adminBumpAppVersion(pin){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var props = PropertiesService.getScriptProperties();
  var current = _appVersion_();
  var next = current + 1;
  props.setProperty('APP_VERSION', String(next));
  return {ok:true,version:next};
}
function _ss(){ var id=_props().getProperty('ssid'); if(!id) return null; try{return SpreadsheetApp.openById(id);}catch(e){return null;} }
function _sheet(ss,name,header){ var sh=ss.getSheetByName(name)||ss.insertSheet(name); if(sh.getLastRow()===0 && header) sh.appendRow(header); return sh; }
function _adminPin(ss){ return String(_sheet(ss,'config',['key','value']).getRange(1,2).getValue()); }
function _adminOK(pin){ var ss=_ss(); return ss && _adminPin(ss)===String(pin||'').trim(); }

function _readPlayers(ss){
  var sh=_sheet(ss,'players',['id','name','pin']); var v=sh.getDataRange().getValues(), out=[];
  for(var i=1;i<v.length;i++){ if(v[i][0]==='') continue; out.push({id:Number(v[i][0]), name:String(v[i][1]||('Player '+v[i][0])), pin:String(v[i][2]||'')}); }
  return out;
}
function _readPreds(ss){
  var sh=_sheet(ss,'preds',['playerId','json']); var v=sh.getDataRange().getValues(), o={};
  for(var i=1;i<v.length;i++){ var id=Number(v[i][0]); if(!id) continue; try{o[id]=JSON.parse(v[i][1]||'{}');}catch(e){o[id]={};} }
  return o;
}
function _readKO(ss){
  var sh=_sheet(ss,'ko',['no','home','away','iso','stage']); var v=sh.getDataRange().getValues(), o={};
  for(var i=1;i<v.length;i++){ var no=Number(v[i][0]); if(!no) continue; o[no]={h:String(v[i][1]||''),a:String(v[i][2]||''),iso:String(v[i][3]||''),stage:String(v[i][4]||'')}; }
  return o;
}
function _readResults(ss){
  var sh=_sheet(ss,'results',['no','hg','ag','winner','pen']); var v=sh.getDataRange().getValues(), o={};
  for(var i=1;i<v.length;i++){
    var no=Number(v[i][0]); if(!no) continue;
    o[no]={hg:Number(v[i][1]),ag:Number(v[i][2]),w:String(v[i][3]||''),pen:String(v[i][4]||'')==='TRUE'||v[i][4]===true||String(v[i][4]||'').toLowerCase()==='true'};
  }
  return o;
}

function _mergedMatch(m,ko){ var x=JSON.parse(JSON.stringify(m)); var o=ko[m.no]; if(o){ if(o.h) x.h=o.h; if(o.a) x.a=o.a; if(o.iso) x.iso=o.iso; if(o.stage) x.stage=o.stage; } if(!x.group){ var gm=String(x.stage||'').match(/Group\s*([A-L])/i); if(gm) x.group=gm[1].toUpperCase(); } return x; }
function _matches(ss){
  var ko=_readKO(ss);
  return MATCHES.map(function(m){return _mergedMatch(m,ko);}).sort(function(a,b){
    var ta=new Date(a.iso||'').getTime(), tb=new Date(b.iso||'').getTime();
    if(!isNaN(ta) && !isNaN(tb) && ta!==tb) return ta-tb;
    return a.no-b.no;
  });
}

// Used only for football-data.org matching. Never use the ko sheet here.
// The ko sheet is an output of API sync/manual edits, so using it as an input
// makes a bad previous sync self-reinforcing: a wrongly saved team/time can keep
// mapping the same API fixture to the same wrong match number.
function _canonicalMatchesForApiMapping_(){
  return MATCHES.map(function(m){ return JSON.parse(JSON.stringify(m)); });
}
function _isKOStage(stage, matchNo){ var no=Number(matchNo||0); if(no>=73) return true; return !/^Group/i.test(String(stage||'')); }
function _isPlaceholderTeam_(s){
  s = String(s || '').trim();
  if (!s || s === 'TBD') return true;
  if (/^[WL]\d+$/i.test(s)) return true;       // W74, L101
  if (/^[1-3][A-L]{1,}$/i.test(s)) return true; // 1A, 2B, 3EHIJK
  return false;
}
function _teamsConfirmed_(m){ return m && !_isPlaceholderTeam_(m.h) && !_isPlaceholderTeam_(m.a); }
function _bettingGateOpen_(results){ return !!(results && results[87]); }
function _isLocked(m,results,now){ if(results[m.no]) return true; if(!_teamsConfirmed_(m)) return true; if(!m.iso) return true; var t=new Date(m.iso).getTime(); if(isNaN(t)) return true; return now >= (t-LOCK_MS); }
function _validScore(x){ if(x===''||x==null) return false; var n=Number(x); return !isNaN(n)&&n>=0&&n<=30&&Math.floor(n)===n; }
function _cleanPick(p){ if(!p) return null; if(!_validScore(p.hg)||!_validScore(p.ag)) return null; var o={hg:Number(p.hg), ag:Number(p.ag)}; if(p.w==='H'||p.w==='A') o.w=p.w; if(p.pen===true || String(p.pen).toLowerCase()==='true') o.pen=true; return o; }
function _cleanResult(r){ if(!r) return null; if(!_validScore(r.hg)||!_validScore(r.ag)) return null; var o={hg:Number(r.hg), ag:Number(r.ag)}; if(r.w==='H'||r.w==='A') o.w=r.w; if(r.pen===true || String(r.pen).toLowerCase()==='true') o.pen=true; return o; }
function _predictedWinner(p){ if(!p) return ''; if(p.hg>p.ag) return 'H'; if(p.ag>p.hg) return 'A'; return p.w||'D'; }
function _actualWinner(r){ if(!r) return ''; if(r.hg>r.ag) return 'H'; if(r.ag>r.hg) return 'A'; return r.w||'D'; }
function _missingKODrawWinner(p, match){
  p = _cleanPick(p);
  if(!p || !_isKOStage(match && match.stage, match && match.no)) return false;
  return p.hg === p.ag && p.w !== 'H' && p.w !== 'A';
}
// Rounds to the nearest cent (2 decimals). Used for bet payouts so parimutuel
// shares are exact rather than floored to whole points.
function _round2(n){ return Math.round((Number(n)||0) * 100) / 100; }

function setupLeague(adminPin){
  adminPin=String(adminPin||'').trim(); if(!/^\d{4}$/.test(adminPin)) return {ok:false,msg:'PIN must be 4 digits'};
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    if(_props().getProperty('ssid')) return {ok:false,msg:'League already exists — refresh the page.'};
    var ss=SpreadsheetApp.create('WC26 Prediction League — Data');
    var cfg=ss.getActiveSheet(); cfg.setName('config'); cfg.getRange(1,1,1,2).setValues([['adminPin',adminPin]]);
    var pl=ss.insertSheet('players'); pl.appendRow(['id','name','pin']); var rows=[]; for(var i=1;i<=18;i++) rows.push([i,'Player '+i,'']); pl.getRange(2,1,18,3).setValues(rows);
    ss.insertSheet('preds').appendRow(['playerId','json']);
    ss.insertSheet('results').appendRow(['no','hg','ag','winner','pen']);
    ss.insertSheet('ko').appendRow(['no','home','away','iso','stage']);
    ss.insertSheet('champion').appendRow(['key','value']);
    ss.insertSheet('bets').appendRow(['playerId','matchNo','team','amount','settled','payout']);
    ss.insertSheet('adjustments').appendRow(['playerId','amount','reason','adminNote','ts']);
    _props().setProperty('ssid',ss.getId()); return {ok:true, spreadsheetUrl:ss.getUrl()};
  } finally { lock.releaseLock(); }
}

function getState(playerId,pin){
  var ss=_ss(); if(!ss) return {needsSetup:true, serverNow:Date.now()};
  playerId=Number(playerId||0); pin=String(pin||'').trim();
  // Anonymous fast path: logged-out visitors all get the same payload, so build
  // it once per 45s and share it. serverNow and liveScores are refreshed per
  // request (both are cheap); _cacheBust() clears this the moment data changes.
  if(!playerId||!pin){
    var cj=null; try{ cj=_cache().get('state_anon_v1'); }catch(e){}
    if(cj){ try{ var cp=JSON.parse(cj); cp.serverNow=Date.now(); cp.liveScores=_getLiveScores(); return cp; }catch(e){} }
  }
  var playersFull=_readPlayers(ss), players=playersFull.map(function(p){return {id:p.id,name:p.name,hasPin:!!p.pin};});
  var results=_readResults(ss), resultTimes=_readResultFinishedTimes_(), matches=_matches(ss), myPreds={};
  var ok=false; playersFull.forEach(function(p){ if(p.id===playerId && p.pin && p.pin===pin) ok=true; });

  // Speed patch: anonymous visitors do not need the heavy prediction/bet/adjustment reads.
  // Authenticated users still receive their own predictions, bets, and balance exactly as before.
  var allPreds={}, bets=[], bettedMatches={}, adjs=[], myBalance=null;
  if(ok){
    allPreds=_readPreds(ss);
    myPreds=(allPreds[playerId]||{});
    bets=_readBets(ss);
    bets.forEach(function(b){if(b.playerId===playerId)bettedMatches[b.matchNo]=b;});
    adjs=_readAdjustments(ss);
    try{myBalance=_playerBalance(playerId,playersFull,results,allPreds,matches,bets,adjs,_readChampion(ss));}catch(e){}
  }

  var champData=_ensureChampionPublic_(ss); var _nowMs=Date.now(); var _earlyMs=new Date(CHAMPION_LOCK_ISO).getTime(); var _switchMs=new Date(CHAMPION_SWITCH_ISO).getTime(); var _phase=_nowMs<_earlyMs?'early':(_nowMs<_switchMs?'switch':'locked'); var myChamp=(ok&&champData.picks&&champData.picks[playerId])||null; var myOrig=(ok&&champData.pickPublic&&champData.pickPublic[playerId])||''; var _canPick=ok&&(_phase!=='locked'); var _picksOut=_phase==='locked'?champData.picks:(_phase==='switch'?champData.pickPublic:{}); var _changedMap={}; if(_phase==='locked'){var _pk=champData.picks,_pp=champData.pickPublic; Object.keys(_pk).forEach(function(id){var t1=_pk[id],t0=_pp[id]||''; if(t1&&((!t0)||t1!==t0))_changedMap[id]=true;});} var hiddenTabsRaw=_props().getProperty('HIDDEN_TABS')||'[]'; var hiddenTabs=[]; try{hiddenTabs=JSON.parse(hiddenTabsRaw);}catch(e){} var payload={needsSetup:false, serverNow:Date.now(), v:_appVersion_(), lockMs:LOCK_MS, matches:matches, players:players, results:results, resultTimes:resultTimes, myPreds:myPreds, myBets:ok?bettedMatches:{}, myBalance:myBalance, hiddenTabs:hiddenTabs, champion:{picks:_picksOut, changedMap:_changedMap, pickCount:Object.keys(champData.picks||{}).length, winner:champData.winner||'', locked:_phase==='locked', phase:_phase, canPick:_canPick, myPick:myChamp, myOriginal:myOrig, earlyLockIso:CHAMPION_LOCK_ISO, switchLockIso:CHAMPION_SWITCH_ISO, lockIso:CHAMPION_LOCK_ISO, bonusEarly:CHAMPION_BONUS_EARLY, bonusSwitched:CHAMPION_BONUS_SWITCHED},
    scoring:{rules:'Exact score Group +2, R32 +6, R16 +8, QF +12, SF +20, 3rd +20, Final +32; Correct winner/draw Group +1, R32 +3, R16 +4, QF +6, SF +10, 3rd +10, Final +16; Wrong pick knockout only R32 -3, R16 -4, QF -6, SF -10, 3rd -10, Final -16'},
    liveScores:_getLiveScores()};
  // Only the anonymous payload is shared/cached; per-player payloads never are.
  if(!ok){ try{ _cache().put('state_anon_v1', JSON.stringify(payload), 45); }catch(e){} }
  return payload;
}

function _cleanPlayerName(name){
  name = String(name || '').trim();
  name = name.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  if (name.length > 30) name = name.slice(0, 30);
  return name;
}

function login(playerId,pin,displayName){
  pin=String(pin||'').trim(); playerId=Number(playerId); if(!/^\d{4}$/.test(pin)) return {ok:false,msg:'PIN must be 4 digits'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up yet'};
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    var sh=ss.getSheetByName('players'), v=sh.getDataRange().getValues();
    for(var i=1;i<v.length;i++) if(Number(v[i][0])===playerId){
      var stored=String(v[i][2]||'');
      var currentName=String(v[i][1]||('Player '+playerId));
      var authenticated=false, isNew=false;
      if(!stored){
        // New member first login — sets name and PIN
        var chosen=_cleanPlayerName(displayName);
        if(!chosen) chosen=currentName;
        sh.getRange(i+1,2).setValue(chosen);
        sh.getRange(i+1,3).setValue(pin);
        currentName=chosen; authenticated=true; isNew=true;
      } else if(stored===pin){
        authenticated=true;
      } else {
        return {ok:false,msg:'Wrong PIN'};
      }
      if(!authenticated) return {ok:false,msg:'Wrong PIN'};
      // Return personal data so client skips the second getState call
      lock.releaseLock();
      var allPreds=_readPreds(ss), myPreds=allPreds[playerId]||{};
      var bets=_readBets(ss), myBets={};
      bets.forEach(function(b){ if(Number(b.playerId)===playerId) myBets[b.matchNo]=b; });
      var players=_readPlayers(ss), results=_readResults(ss), matches=_matches(ss), adjs=_readAdjustments(ss);
      var myBalance=null;
      try{ myBalance=_playerBalance(playerId,players,results,allPreds,matches,bets,adjs,_readChampion(ss)); }catch(e){}
      return {ok:true,name:currentName,registered:!isNew,myPreds:myPreds,myBets:myBets,myBalance:myBalance};
    }
    return {ok:false,msg:'Player not found'};
  } finally { try{lock.releaseLock();}catch(e){} }
}

// Auto-cancels the player's own OPEN (unsettled) bet on a match if it no
// longer matches their just-updated prediction. Settled bets are left alone
// — once a match is finished, a bet is final regardless of later prediction
// edits (which shouldn't be possible anyway once a match is locked/finished).
function _cancelBetForPrediction_(ss, playerId, matchNo, predictedTeam) {
  var sh = _sheet(ss, 'bets', ['playerId','matchNo','team','amount','settled','payout']);
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (Number(v[i][0]) === playerId && Number(v[i][1]) === matchNo && !v[i][4]) {
      var betTeam = String(v[i][2] || '');
      if (betTeam && betTeam !== predictedTeam) {
        var cancelled = { matchNo: matchNo, team: betTeam, amount: Number(v[i][3] || 0) };
        sh.deleteRow(i + 1);
        return cancelled;
      }
      return null; // bet still matches the (possibly re-confirmed) prediction
    }
  }
  return null; // no open bet on this match
}

function savePreds(playerId,pin,preds){
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'}; playerId=Number(playerId); pin=String(pin||'').trim();
  var player=null; _readPlayers(ss).forEach(function(p){ if(p.id===playerId) player=p; }); if(!player||player.pin!==pin) return {ok:false,msg:'Session expired — log in again'};
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    var results=_readResults(ss), matches=_matches(ss), sh=_sheet(ss,'preds',['playerId','json']), v=sh.getDataRange().getValues(); var row=-1, existing={};
    for(var r=1;r<v.length;r++) if(Number(v[r][0])===playerId){ row=r+1; try{existing=JSON.parse(v[r][1]||'{}');}catch(e){} break; }
    var merged={}, rejected=[], invalidKODraws=[], cancelledBets=[], now=Date.now(), dirty=false;
    matches.forEach(function(m){
      var no=m.no, oldP=existing[no]||existing[String(no)]||null;
      // A key ABSENT from the payload means "unchanged" — never a deletion.
      // (Protects against partial payloads when the client UI is filtered.)
      var provided = preds && (Object.prototype.hasOwnProperty.call(preds,no) || Object.prototype.hasOwnProperty.call(preds,String(no)));
      if(!provided){ if(oldP) merged[no]=oldP; return; }
      var raw = Object.prototype.hasOwnProperty.call(preds,no) ? preds[no] : preds[String(no)];
      var newP=_cleanPick(raw);

      // Auto-save may fire while the user has only typed one side of the score
      // or while the browser is holding a temporary/invalid value. Treat that
      // as unchanged. Never delete a previously saved prediction just because
      // one auto-save payload is incomplete.
      if(!newP){ if(oldP) merged[no]=oldP; return; }

      if(_isKOStage(m.stage,m.no)){
        // Knockout rule: if the player predicts a draw, they MUST choose
        // which team qualifies. Do not save an incomplete KO draw. This
        // prevents auto-save from accepting 1-1 / 2-2 before the penalty
        // winner dropdown/button has been selected.
        if(newP.hg === newP.ag){
          newP.pen = true;
          if(newP.w !== 'H' && newP.w !== 'A'){
            rejected.push(no);
            invalidKODraws.push(no);
            if(oldP) merged[no]=oldP;
            return;
          }
        } else { delete newP.pen; delete newP.w; }
      } else {
        delete newP.pen; delete newP.w;
      }
      var changed=JSON.stringify(oldP||null)!==JSON.stringify(newP||null);
      if(changed&&_isLocked(m,results,now)){rejected.push(no); if(oldP) merged[no]=oldP; return;}
      if(newP){merged[no]=newP; if(changed) dirty=true;}
      // Betting only cares about which team advances, never the exact score.
      // So a bet is only auto-cancelled when the predicted ADVANCING TEAM
      // itself changes (or is cleared) — editing the scoreline while keeping
      // the same team leaves any open bet untouched.
      if(no>=89){
        var oldTeam = oldP ? _predictedWinner(oldP) : '';
        var newTeam = newP ? _predictedWinner(newP) : '';
        if(oldTeam !== newTeam){
          var cancelled = _cancelBetForPrediction_(ss, playerId, no, newTeam);
          if(cancelled) cancelledBets.push(cancelled);
        }
      }
    });

    // Avoid hammering the spreadsheet on every auto-save tick when nothing
    // actually changed. This reduces lock contention, timeout complaints, and
    // the feeling that auto-save is unstable during busy match windows.
    if(!dirty && row>=0){
      if(cancelledBets.length){ _cacheBust(); _boardTouch_(); }
      return {ok:true,rejected:rejected,invalidKODraws:invalidKODraws,preds:existing,cancelledBets:cancelledBets,noChange:true};
    }
    if(!dirty && row<0 && Object.keys(merged).length===0){
      return {ok:true,rejected:rejected,invalidKODraws:invalidKODraws,preds:{},cancelledBets:cancelledBets,noChange:true};
    }

    if(row<0) sh.appendRow([playerId,JSON.stringify(merged)]); else sh.getRange(row,2).setValue(JSON.stringify(merged));
    // No _cacheBust() here: a pick save affects only the odds payload, and odds
    // refresh by TTL. Busting on every auto-save (players type → save every
    // 1.2s) kept the odds cache permanently cold during matchdays, forcing a
    // full all-predictions recompute for nearly every Odds page view.
    // Exception: if a bet was cancelled, the betting pools actually changed,
    // so that DOES need a cache bust.
    if(cancelledBets.length){ _cacheBust(); _boardTouch_(); }
    return {ok:true,rejected:rejected,invalidKODraws:invalidKODraws,preds:merged,cancelledBets:cancelledBets};
  } finally { lock.releaseLock(); }
}

function _scoreOne(pred,result,match){
  pred=_cleanPick(pred); result=_cleanResult(result);
  var none={points:0, exact:false, outcome:false, penaltyExact:false, wrong:false, incomplete:false};
  if(!pred||!result) return none;

  var ko = _isKOStage(match.stage, match.no);
  if (ko) {
    // Backward-compatible with the new UI: a KO draw prediction implies penalties.
    // This also protects older saved draw+winner predictions that may have pen=false.
    if (pred.hg === pred.ag) pred.pen = true;
    else { delete pred.pen; delete pred.w; }
  }
  var vals = _scoreValues(match.stage, match.no);
  var scoreExact = (pred.hg === result.hg && pred.ag === result.ag);

  // Group stage: no penalties, no winner selector. Exact first, then 1X2 outcome.
  if (!ko) {
    if (scoreExact) return {points:vals.exact, exact:true, outcome:true, penaltyExact:false, wrong:false, incomplete:false};
    if (_predictedWinner(pred) === _actualWinner(result)) return {points:vals.outcome, exact:false, outcome:true, penaltyExact:false, wrong:false, incomplete:false};
    return {points:0, exact:false, outcome:false, penaltyExact:false, wrong:true, incomplete:false}; // wrong pick, no deduction in groups
  }

  // Knockout: the advancing team is what matters.
  var actualQ = _actualWinner(result);
  if (actualQ !== 'H' && actualQ !== 'A') {
    // KO result saved as a draw with no advancing team chosen — result is
    // incomplete. Score nothing (and nothing negative) until admin fixes it.
    return {points:0, exact:false, outcome:false, penaltyExact:false, wrong:false, incomplete:true};
  }
  var predQ = _predictedWinner(pred); // H/A from score, or selected winner on a predicted draw

  // Historical protection: older auto-saved KO draw predictions may have no
  // selected qualifier (predQ = 'D'). Do not let those become a wrong-team
  // penalty after the match. Give only the scoreline portion if the 120' score
  // is exact; otherwise 0. Future saves are blocked in savePreds().
  if (predQ !== 'H' && predQ !== 'A') {
    var scoreOnlyPts = scoreExact ? Math.max(0, vals.exact - vals.outcome) : 0;
    return {points:scoreOnlyPts, exact:false, outcome:false, penaltyExact:false, wrong:false, incomplete:false, missingWinner:true, scoreOnly:scoreExact};
  }

  if (predQ !== actualQ) {
    return {points:vals.wrong, exact:false, outcome:false, penaltyExact:false, wrong:true, incomplete:false};
  }

  // Correct advancing team → never negative.
  // Full exact on a penalty shootout still requires: exact 120' score
  // + penalties predicted + correct penalty winner (strict rule kept).
  var exact=false, penaltyExact=false;
  if (result.pen) { penaltyExact = scoreExact && !!pred.pen && pred.w === result.w; exact = penaltyExact; }
  else { exact = scoreExact; }
  var pts = exact ? vals.exact : vals.outcome;
  return {points:pts, exact:exact, outcome:true, penaltyExact:penaltyExact, wrong:false, incomplete:false};
}


function adminTestKnockoutScoring(pin) {
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var m = {no:73, stage:'Round of 32', h:'Egypt', a:'Ghana'};
  return {
    ok:true,
    wrongPenaltyWinner:_scoreOne({hg:1,ag:1,pen:true,w:'H'}, {hg:1,ag:1,pen:true,w:'A'}, m),
    correctPenaltyWinner:_scoreOne({hg:1,ag:1,pen:true,w:'A'}, {hg:1,ag:1,pen:true,w:'A'}, m),
    correctWinnerOnly:_scoreOne({hg:0,ag:0,pen:true,w:'A'}, {hg:1,ag:1,pen:true,w:'A'}, m),
    regulationPickRightTeamPens:_scoreOne({hg:2,ag:1}, {hg:1,ag:1,pen:true,w:'H'}, m), // must be +outcome, not negative
    missingPenaltyWinner:_scoreOne({hg:1,ag:1,pen:true}, {hg:1,ag:1,pen:true,w:'A'}, m) // no wrong-team penalty
  };
}

function getLeaderboard(){
  var ver=_boardVer_();
  var snap=_boardRead_();
  if(snap && snap.ver===ver && (Date.now()-(snap.builtAt||0))<600000) return snap; // fresh snapshot → no compute
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  // Rebuild once, guarded so a burst of viewers right after a result drops
  // doesn't all recompute simultaneously (the matchday spike we're fixing).
  var lock=LockService.getScriptLock(), got=false;
  try{ got=lock.tryLock(8000); }catch(e){}
  if(got){
    try{
      var v2=_boardVer_(), s2=_boardRead_();
      if(s2 && s2.ver===v2 && (Date.now()-(s2.builtAt||0))<600000) return s2; // someone rebuilt while we waited
      var payload=_computeBoard_(ss); payload.ver=v2; payload.builtAt=Date.now(); _boardStore_(payload); return payload;
    } finally { try{ lock.releaseLock(); }catch(e){} }
  }
  if(snap) return snap;                 // couldn't grab lock quickly: serve slightly stale rather than pile on
  var p=_computeBoard_(ss); p.ver=ver; p.builtAt=Date.now(); return p;
}
function _computeBoard_(ss){
  var players=_readPlayers(ss), results=_readResults(ss), preds=_readPreds(ss), ms=_matches(ss), map={}; ms.forEach(function(m){map[m.no]=m;});
  var bets=_readBets(ss);
  // Leaderboard counts DECIDED bets only. An open/pending bet stakes points
  // the instant it's placed, which used to make the public leaderboard dip
  // before a match was even played — unstable and not a reflection of
  // prediction skill. Once a bet settles (win or lose), the real outcome is
  // final and counts toward the total like any other result.
  var settledBets=bets.filter(function(b){ return b.settled; });
  var adjs=_readAdjustments(ss);
  var champ=_readChampion(ss);
  var table=players.map(function(p){ var total=0, exact=0, outcome=0, wrong=0, played=0; Object.keys(results).forEach(function(no){ var pr=(preds[p.id]||{})[no]; if(!pr) return; var s=_scoreOne(pr,results[no],map[no]||{stage:''}); if(s.incomplete) return; total+=s.points; played++; if(s.exact) exact++; else if(s.outcome) outcome++; if(s.wrong) wrong++; }); var balance=_playerBalance(p.id,players,results,preds,ms,settledBets,adjs,champ); var wins=exact+outcome; return {id:p.id,name:p.name,total:balance,wins:wins,losses:wrong,played:played,exact:exact,outcome:outcome,wrong:wrong,predictedPlayed:played}; });
  table.sort(function(a,b){ return b.total-a.total || b.exact-a.exact || b.outcome-a.outcome || a.wrong-b.wrong || a.name.localeCompare(b.name); }); var topScore=table.length?table[0].total:null; var leaderIds=table.filter(function(p){return p.total===topScore;}).map(function(p){return p.id;});
  // Attach throne messages inline (avoids a 2nd server round-trip)
  var messages={};
  if(leaderIds.length<=3){
    var raw=_props().getProperty('LEADER_MSGS')||'{}'; var mmap={}; try{mmap=JSON.parse(raw);}catch(e){}
    var now2=Date.now(), pruned=false;
    Object.keys(mmap).forEach(function(pid){ var mm=mmap[pid]; if(mm&&now2<=mm.expires&&leaderIds.indexOf(Number(pid))>=0){messages[pid]=mm;}else{pruned=true;} });
    if(pruned){ try{_props().setProperty('LEADER_MSGS',JSON.stringify(messages));}catch(e){} }
  }
  var payload={ok:true,table:table,leaderIds:leaderIds,messages:messages,tooManyLeaders:leaderIds.length>3}; return payload;
}
function adminRebuildBoard(pin){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'}; _boardTouch_(); var p=_computeBoard_(ss); p.ver=_boardVer_(); p.builtAt=Date.now(); _boardStore_(p); return {ok:true,players:(p.table||[]).length}; }

// Wipes all API/manual KO overrides for matches 73–104 from the ko table.
// Important: clear the saved kickoff time too, not only team names. A previous
// bad sync may have saved Brazil/Japan's API time under #75; preserving that time
// makes the next sync keep mapping Brazil/Japan to #75 instead of FIFA #76.
function adminClearKOTeams(pin) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var ko = _readKO(ss);
  var cleared = 0;
  Object.keys(ko).forEach(function(no) {
    no = Number(no);
    if (no < 73) return; // leave group-stage/manual non-KO rows untouched
    delete ko[no];
    cleared++;
  });
  var rows = [];
  Object.keys(ko).sort(function(a,b){return Number(a)-Number(b);}).forEach(function(no) {
    var k = ko[no];
    if (k && (k.h || k.a || k.iso || k.stage))
      rows.push([Number(no), k.h||'', k.a||'', k.iso||'', k.stage||'']);
  });
  var sh = _sheet(ss, 'ko', ['no','home','away','iso','stage']);
  sh.clearContents(); sh.appendRow(['no','home','away','iso','stage']);
  if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
  _cacheBust();
  return {ok: true, msg: 'Cleared all KO overrides for ' + cleared + ' matches. Trigger a sync to repopulate from football-data.org.'};
}

function getOdds(includeCompleted){
  includeCompleted = !!includeCompleted; // true = completed archive only
  var cacheKey = includeCompleted ? 'odds_v5_completed' : 'odds_v5_current';
  var cached=null; try{ cached=_cache().get(cacheKey); }catch(e){}
  if(cached){ try{ return JSON.parse(cached); }catch(e){} }

  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var all=_readPreds(ss), players=_readPlayers(ss), results=_readResults(ss), resultTimes=_readResultFinishedTimes_(), matches=_matches(ss), now=Date.now(), out=[];
  var visMode=_props().getProperty('PRED_VISIBILITY')||'hidden';
  var nameMap={}; players.forEach(function(p){ nameMap[p.id]=p.name; });

  var completedCount = 0;
  matches.forEach(function(m){ if(results[m.no]) completedCount++; });
  var recentCompletedCount=0;
  matches.forEach(function(m){if(results[m.no]&&_showResultOnMain_(m,resultTimes,now))recentCompletedCount++;});
  var hiddenCompletedCount = includeCompleted ? 0 : Math.max(0, completedCount-recentCompletedCount);

  // Current view: every unfinished match plus results still inside the six-hour
  // window (the Final is permanent). Completed view: archive only.
  var completedMatches = matches.filter(function(m){ return !!results[m.no]; });
  completedMatches.sort(function(a,b){
    var ta=new Date(a.iso||0).getTime()||0, tb=new Date(b.iso||0).getTime()||0;
    return tb-ta || Number(b.no)-Number(a.no);
  });
  var visibleMatches = includeCompleted
    ? completedMatches
    : matches.filter(function(m){ return !results[m.no] || _showResultOnMain_(m,resultTimes,now); });

  visibleMatches.forEach(function(m){
    var ko=_isKOStage(m.stage,m.no);
    var h=0,d=0,a=0,pen=0,total=0, scores={}, predList=[];
    Object.keys(all).forEach(function(pid){
      var p=_cleanPick(all[pid]&&all[pid][m.no]); if(!p) return; total++;
      var w=_predictedWinner(p); if(w==='H') h++; else if(w==='A') a++; else d++;
      var koDrawWithWinner = ko && Number(p.hg)===Number(p.ag) && !!p.w;
      if(p.pen || koDrawWithWinner) pen++; var key=p.hg+'-'+p.ag; scores[key]=(scores[key]||0)+1;
      if(visMode!=='hidden'){
        var entry={hg:p.hg,ag:p.ag};
        if(p.w) entry.w=p.w; if(p.pen || koDrawWithWinner) entry.pen=true;
        if(visMode==='named') entry.name=nameMap[Number(pid)]||('P'+pid);
        predList.push(entry);
      }
    });
    var hidden = HIDE_ODDS_UNTIL_LOCK && !_isLocked(m,results,now);
    var done=!!results[m.no];
    if(hidden){
      out.push({no:m.no,stage:m.stage,group:m.group||'',h:m.h,a:m.a,iso:m.iso,ko:ko,done:done,total:total,H:null,D:null,A:null,pen:null,top:null,hidden:true,predictions:[]});
    } else {
      var top=Object.keys(scores).sort(function(x,y){return scores[y]-scores[x] || x.localeCompare(y);}).slice(0,3).map(function(k){return {score:k,count:scores[k]};});
      if(visMode==='named') predList.sort(function(x,y){return String(x.name).localeCompare(String(y.name));});
      out.push({no:m.no,stage:m.stage,group:m.group||'',h:m.h,a:m.a,iso:m.iso,ko:ko,done:done,total:total,H:h,D:d,A:a,pen:pen,top:top,hidden:false,predictions:predList});
    }
  });
  var payload={ok:true,totalPlayers:players.length,odds:out,visMode:visMode,includeCompleted:includeCompleted,completedCount:completedCount,hiddenCompletedCount:hiddenCompletedCount};
  // Odds are a crowd trajectory — up to 2 min stale is fine. Results and
  // visibility changes still _cacheBust() for an immediate refresh.
  try{ _cache().put(cacheKey, JSON.stringify(payload), 120); }catch(e){}
  return payload;
}

function adminLogin(pin){ return {ok:_adminOK(pin)}; }

function adminGetIncompleteKODraws(pin){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var players=_readPlayers(ss), preds=_readPreds(ss), results=_readResults(ss), matches=_matches(ss), now=Date.now();
  var pName={}; players.forEach(function(p){ pName[p.id]=p.name; });
  var rows=[];
  matches.forEach(function(m){
    if(!_isKOStage(m.stage,m.no)) return;
    players.forEach(function(pl){
      var mine=preds[pl.id]||{};
      var pick=_cleanPick(mine[m.no]||mine[String(m.no)]);
      if(_missingKODrawWinner(pick,m)){
        rows.push({
          playerId:pl.id,
          name:pName[pl.id]||('Player '+pl.id),
          matchNo:m.no,
          match:(m.h||'')+' vs '+(m.a||''),
          stage:m.stage,
          pred:pick,
          finished:!!results[m.no],
          locked:_isLocked(m,results,now)
        });
      }
    });
  });
  return {ok:true,rows:rows,count:rows.length};
}

function adminGetPredictions(pin, playerId){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  playerId=Number(playerId||0);
  var players=_readPlayers(ss), selected=null;
  players.forEach(function(p){ if(p.id===playerId) selected=p; });
  if(!selected) return {ok:false,msg:'Player not found'};
  var all=_readPreds(ss), mine=all[playerId]||{}, results=_readResults(ss), matches=_matches(ss);
  var rows=matches.map(function(m){
    var p=_cleanPick(mine[m.no]) || null;
    if(p && !_isKOStage(m.stage,m.no)){ delete p.pen; delete p.w; }
    var r=results[m.no] || null;
    var score = (p && r) ? _scoreOne(p,r,m) : {points:null, exact:false, outcome:false, wrong:false, penaltyExact:false};
    return {
      no:m.no, stage:m.stage, h:m.h, a:m.a, iso:m.iso, isKO:_isKOStage(m.stage),
      pred:p, result:r, points:score.points, exact:score.exact, outcome:score.outcome, wrong:score.wrong, penaltyExact:score.penaltyExact, incomplete:!!score.incomplete, missingWinner:!!score.missingWinner
    };
  });
  return {ok:true, player:{id:selected.id,name:selected.name}, rows:rows};
}

function adminGetAllPredictions(pin){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var players=_readPlayers(ss);
  return {ok:true, players:players.map(function(p){return {id:p.id,name:p.name,hasPin:!!p.pin};})};
}

function adminRenamePlayer(pin,playerId,newName){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  newName=_cleanPlayerName(newName); if(!newName) return {ok:false,msg:'Name required'};
  var ss=_ss(), sh=ss.getSheetByName('players'), v=sh.getDataRange().getValues();
  for(var i=1;i<v.length;i++) if(Number(v[i][0])===Number(playerId)){ sh.getRange(i+1,2).setValue(newName); _boardTouch_(); return {ok:true,name:newName}; }
  return {ok:false,msg:'Player not found'};
}
function adminForcePin(pin,playerId,newPin){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  newPin=String(newPin||'').trim(); if(!/^\d{4}$/.test(newPin)) return {ok:false,msg:'PIN must be 4 digits'};
  var ss=_ss(), sh=ss.getSheetByName('players'), v=sh.getDataRange().getValues();
  for(var i=1;i<v.length;i++) if(Number(v[i][0])===Number(playerId)){ sh.getRange(i+1,3).setValue(newPin); return {ok:true}; }
  return {ok:false,msg:'Player not found'};
}
function adminClearPlayerPreds(pin,playerId){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  playerId=Number(playerId);
  // Locked: this can also delete rows on the bets sheet, and must never
  // interleave with placeBet/cancelBet, which append/delete rows on the
  // same sheet under this same lock.
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    var sh=_sheet(ss,'preds',['playerId','json']), v=sh.getDataRange().getValues(), found=false;
    for(var i=1;i<v.length;i++) if(Number(v[i][0])===playerId){ sh.getRange(i+1,2).setValue('{}'); found=true; break; }
    if(!found) return {ok:false,msg:'Player not found'};

    // Every prediction is gone, so no open bet is backed by a prediction
    // anymore. Cancel every open (unsettled) bet this player has, on any
    // match, so the "bet only on what you predicted" rule stays intact.
    // Iterate bottom-up: deleteRow shifts later rows up, so deleting
    // top-down would skip rows.
    var betSh=_sheet(ss,'bets',['playerId','matchNo','team','amount','settled','payout']);
    var bv=betSh.getDataRange().getValues(), cancelledCount=0;
    for(var j=bv.length-1;j>=1;j--){
      if(Number(bv[j][0])===playerId && !bv[j][4]){ betSh.deleteRow(j+1); cancelledCount++; }
    }
    if(cancelledCount) _cacheBust();
    _boardTouch_();
    return {ok:true, cancelledBets:cancelledCount};
  } finally { lock.releaseLock(); }
}
function adminSavePlayers(pin,names){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; var ss=_ss(), sh=ss.getSheetByName('players'), v=sh.getDataRange().getValues(); for(var i=1;i<v.length;i++){ var id=Number(v[i][0]); if(names&&names[id]!=null) sh.getRange(i+1,2).setValue(String(names[id]).trim()||('Player '+id)); } _boardTouch_(); return {ok:true}; }
function adminResetPin(pin,playerId){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; var ss=_ss(), sh=ss.getSheetByName('players'), v=sh.getDataRange().getValues(); for(var i=1;i<v.length;i++) if(Number(v[i][0])===Number(playerId)){ sh.getRange(i+1,3).setValue(''); return {ok:true}; } return {ok:false,msg:'Player not found'}; }
function _writeKO_(ss,ko,merge){ var cur=merge?_readKO(ss):{}; Object.keys(ko||{}).forEach(function(no){ cur[no]=cur[no]||{}; ['h','a','iso','stage'].forEach(function(k){ if(ko[no][k]!=null) cur[no][k]=ko[no][k]; }); }); var rows=[]; Object.keys(cur).sort(function(a,b){return Number(a)-Number(b);}).forEach(function(no){ var k=cur[no]; if(k&&(k.h||k.a||k.iso||k.stage)) rows.push([Number(no),k.h||'',k.a||'',k.iso||'',k.stage||'']); }); var sh=_sheet(ss,'ko',['no','home','away','iso','stage']); sh.clearContents(); sh.appendRow(['no','home','away','iso','stage']); if(rows.length) sh.getRange(2,1,rows.length,5).setValues(rows); }
function adminSaveKO(pin,ko){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; _writeKO_(_ss(),ko,false); _cacheBust(); return {ok:true}; }
function _writeResults_(ss,results,merge){
  var cur=merge?_readResults(ss):{};
  var finishedTimes=_readResultFinishedTimes_(), finishedTimesDirty=false;
  var changed=[];
  Object.keys(results||{}).forEach(function(no){
    var r=_cleanResult(results[no]);
    if(r){
      var prev=cur[no];
      // Guard against a transient/incomplete upstream report (most commonly:
      // football-data.org marks a penalty-shootout match FINISHED with the
      // 90/120-minute draw score before it has posted the shootout winner)
      // silently downgrading an already-decisive result back to ambiguous.
      // That previously caused _settleBetsForMatch to wipe correct payouts
      // back to pending and never re-settle them. A genuine correction still
      // has a decisive winner, so this only blocks the nonsensical case.
      var prevDecisive = prev && (_actualWinner(prev)==='H' || _actualWinner(prev)==='A');
      var newDecisive = _actualWinner(r)==='H' || _actualWinner(r)==='A';
      if(prevDecisive && !newDecisive) return; // reject downgrade, keep prev as-is
      var noNum=Number(no), prevComplete=!!prev&&(noNum<=72||prevDecisive), newComplete=(noNum<=72||newDecisive);
      if(newComplete&&!prevComplete&&!Number(finishedTimes[no])){
        finishedTimes[no]=Date.now(); finishedTimesDirty=true;
      }
      if(JSON.stringify(prev)!==JSON.stringify(r)) changed.push(Number(no));
      cur[no]=r;
    }
  });
  var rows=[];
  Object.keys(cur).sort(function(a,b){return Number(a)-Number(b);}).forEach(function(no){
    var r=cur[no]; rows.push([Number(no),r.hg,r.ag,r.w||'',!!r.pen]);
  });
  var sh=_sheet(ss,'results',['no','hg','ag','winner','pen']);
  sh.clearContents(); sh.appendRow(['no','hg','ag','winner','pen']);
  if(rows.length) sh.getRange(2,1,rows.length,5).setValues(rows);
  if(finishedTimesDirty)_writeResultFinishedTimes_(finishedTimes);
  _cacheBust();
  if(changed.length) {
    _propagateKOTeams(ss, changed, cur);
    changed.forEach(function(no){ if(no>=89) _settleBetsForMatch(ss, no, cur[no]||{hg:0,ag:0}); });
    _boardTouch_();
  }
}
function adminSaveResults(pin,results){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  // Locked: _writeResults_ can settle bets (row-index writes on the bets sheet),
  // and must never interleave with placeBet/cancelBet, which delete/append rows
  // on that same sheet under this same lock.
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{ _writeResults_(_ss(),results,true); } finally { lock.releaseLock(); }
  return {ok:true};
}

// ── Result locks ──────────────────────────────────────────────────────────
// Match numbers in this list are treated as "manual / pinned": the football-data
// auto-sync will NOT overwrite their score or teams. Use this when the API has a
// wrong result for a match — correct it manually, lock it, and sync leaves it alone.
function _readResultLocks(){ try{ var p=_props().getProperty('RESULT_LOCKS'); var a=p?JSON.parse(p):[]; return Array.isArray(a)?a.map(Number).filter(function(n){return n>0;}):[]; }catch(e){ return []; } }
function _writeResultLocks(arr){ var u=[]; (arr||[]).forEach(function(n){ n=Number(n); if(n>0 && u.indexOf(n)<0) u.push(n); }); u.sort(function(a,b){return a-b;}); _props().setProperty('RESULT_LOCKS', JSON.stringify(u)); return u; }
function adminGetResultLocks(pin){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; return {ok:true,locks:_readResultLocks()}; }
function adminSetResultLocks(pin,locks){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; var u=_writeResultLocks(locks); _cacheBust(); return {ok:true,locks:u}; }
function adminDeleteResult(pin,matchNo){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  matchNo=Number(matchNo); var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  // Locked for the same reason as adminSaveResults: _settleBetsForMatch does
  // row-index reads/writes on the bets sheet and must not overlap a concurrent
  // placeBet/cancelBet (which append/delete rows on that sheet).
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    var sh=_sheet(ss,'results',['no','hg','ag','winner','pen']), v=sh.getDataRange().getValues();
    for(var i=1;i<v.length;i++){
      if(Number(v[i][0])===matchNo){
        sh.deleteRow(i+1);
        var finishedTimes=_readResultFinishedTimes_();
        if(Object.prototype.hasOwnProperty.call(finishedTimes,String(matchNo))){delete finishedTimes[String(matchNo)];_writeResultFinishedTimes_(finishedTimes);}
        // Unsettled any bets for this match since result is gone
        _settleBetsForMatch(ss, matchNo, {hg:0,ag:0,w:''}); // no winner → all bets reopened
        // Revert any downstream bracket teams this result had advanced, so a stale
        // (now-wrong) team doesn't linger in later rounds.
        if (matchNo >= 73) _rebuildPropagatedSlots_(ss);
        _cacheBust();
        return {ok:true};
      }
    }
    return {ok:false,msg:'Result not found'};
  } finally { lock.releaseLock(); }
}

function setFootballDataToken(pin,token){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; token=String(token||'').trim(); if(!token) return {ok:false,msg:'Missing token'}; _props().setProperty('FOOTBALL_DATA_TOKEN',token); return {ok:true}; }
// (getApiSyncStatus is defined once, further below, with last-sync details.)
function _norm(s){
  var t=String(s||'').toLowerCase()
    .replace(/&/g,'and').replace(/[\u2019']/g,'')
    .replace(/\u00fc/g,'u').replace(/\u00e7/g,'c') // ü→u, ç→c for Türkiye
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\b(the|fc|team|republic|ir)\b/g,'').trim();
  // Canonical synonyms so API names map to our fixture names
  var syn={
    'cape verde islands':'cabo verde','cape verde':'cabo verde',
    'bosnia herzegovina':'bosnia and herzegovina',
    'bosnia herzegovin':'bosnia and herzegovina',
    'turkey':'turkiye','turkiye':'turkiye',
    'czech':'czechia','czech republic':'czechia',
    'korea':'south korea','korea republic':'south korea',
    'dr congo':'congo dr','democratic of congo':'congo dr',
    'ivory coast':'cote divoire',
    'usa':'united states'
  };
  return syn[t]||t;
}
function _apiStageKey(s){ s=String(s||'').toUpperCase(); if(s.indexOf('GROUP')===0)return 'G'; if(s==='LAST_32')return 'R32'; if(s==='LAST_16')return 'R16'; if(s==='QUARTER_FINALS')return 'QF'; if(s==='SEMI_FINALS')return 'SF'; if(s==='THIRD_PLACE'||s==='PLAY_OFF_FOR_THIRD_PLACE')return '3P'; if(s==='FINAL')return 'F'; return ''; }
function _ourStageKey(m){ var no=Number(m.no||0); if(m.group||/^group/i.test(String(m.stage||'')))return 'G'; if(no>=73&&no<=88)return 'R32'; if(no>=89&&no<=96)return 'R16'; if(no>=97&&no<=100)return 'QF'; if(no>=101&&no<=102)return 'SF'; if(no===103)return '3P'; if(no===104)return 'F'; return ''; }
function _apiGroupLetter(g){ var mm=String(g||'').match(/GROUP[_ ]([A-L])/i); return mm?mm[1].toUpperCase():''; }
function _winnerFromApi(m){ var w=m.score&&m.score.winner; if(w==='HOME_TEAM') return 'H'; if(w==='AWAY_TEAM') return 'A'; return ''; }

// football-data v4: matches decided on penalties have score.duration === 'PENALTY_SHOOTOUT'.
// Some payloads fold shootout goals into fullTime; when a penalties object is present and
// fullTime is not a draw, subtracting it recovers the 120-minute score. Defensive on both shapes.
function _apiScore(m){
  var sc=m.score||{}, ft=sc.fullTime||{}, pens=sc.penalties||null;
  var pen = sc.duration==='PENALTY_SHOOTOUT' || !!(pens&&(pens.home!=null||pens.away!=null));
  var hg=ft.home, ag=ft.away;
  if(pen && pens && pens.home!=null && pens.away!=null && hg!=null && ag!=null && hg!==ag){
    var ch=hg-pens.home, ca=ag-pens.away;
    if(ch>=0 && ca>=0 && ch===ca){ hg=ch; ag=ca; }
  }
  return {hg:hg, ag:ag, pen:pen};
}

function _matchScoreFor(apiMatch,m){
  var apiStage=_apiStageKey(apiMatch.stage), ourStage=_ourStageKey(m);
  if(apiStage && ourStage && apiStage!==ourStage) return -1;        // never map across stages
  var apiG=_apiGroupLetter(apiMatch.group);
  var s=0;
  if(apiG && m.group){ if(apiG!==m.group) return -1; s+=60; }       // group must agree when both known
  var ah=_norm(apiMatch.homeTeam&&apiMatch.homeTeam.name), aa=_norm(apiMatch.awayTeam&&apiMatch.awayTeam.name);
  var mh=_norm(m.h), ma=_norm(m.a);
  if(ah&&aa&&mh&&ma){ if(mh===ah&&ma===aa) s+=100; else if(mh===aa&&ma===ah) s+=80; }
  var at=new Date(apiMatch.utcDate||'').getTime(), mt=new Date(m.iso||'').getTime();
  if(!isNaN(at)&&!isNaN(mt)){ var hrs=Math.abs(at-mt)/3600000; if(hrs<=36) s+=Math.max(0,30-hrs); }
  return s;
}

// Three-pass mapping.
// Pass 0 (KO exact time only): api.utcDate → our canonical KO match iso. Every
//   KO kickoff is unique, so this gives a direct 1:1 map for M73–M104 without
//   relying on API order. Do NOT apply exact-time mapping to group matches because
//   several final group games share the same kickoff time.
// Pass 1 (team names): score ≥ 80 — handles group stage with known team names.
// Pass 2 (fallback): stage + time proximity for anything remaining.
function _mapApiMatches(apiMatches, matches) {
  var map = {}, used = {}, unmapped = [];

  // Build exact-time lookup for KO only: UTC milliseconds → our canonical match
  // Use a 60-second tolerance to absorb minor API timestamp rounding.
  var byTimeMs = {};
  matches.forEach(function(m) {
    if (Number(m.no) < 73) return;
    var t = new Date(m.iso || '').getTime();
    if (!isNaN(t)) byTimeMs[t] = m;
  });

  // Pass 0: exact kickoff time match for KO only
  apiMatches.forEach(function(am) {
    var apiStage = _apiStageKey(am.stage);
    if (apiStage !== 'R32' && apiStage !== 'R16' && apiStage !== 'QF' && apiStage !== 'SF' && apiStage !== '3P' && apiStage !== 'F') return;
    var at = new Date(am.utcDate || '').getTime();
    if (isNaN(at)) return;
    // Try exact match first, then ±60s tolerance
    var m = byTimeMs[at];
    if (!m) {
      // scan with 60-second window
      for (var key in byTimeMs) {
        if (Math.abs(Number(key) - at) <= 60000) { m = byTimeMs[key]; break; }
      }
    }
    if (!m || used[m.no]) return;
    // Stage sanity check: never map across stages
    var ourStage = _ourStageKey(m);
    if (apiStage && ourStage && apiStage !== ourStage) return;
    map[am.id] = m;
    used[m.no] = true;
  });

  // Pass 1: confident team-name match (score ≥ 80) for remaining
  apiMatches.forEach(function(am) {
    if (map[am.id]) return;
    var best = null, bs = -1;
    matches.forEach(function(m) {
      if (used[m.no]) return;
      var s = _matchScoreFor(am, m);
      if (s > bs) { bs = s; best = m; }
    });
    if (best && bs >= 80) { map[am.id] = best; used[best.no] = true; }
  });

  // Pass 2: stage + time fallback for any still-unmapped
  apiMatches.forEach(function(am) {
    if (map[am.id]) return;
    var best = null, bs = -1;
    matches.forEach(function(m) {
      if (used[m.no]) return;
      var s = _matchScoreFor(am, m);
      if (s > bs) { bs = s; best = m; }
    });
    var noTeams = !(am.homeTeam && am.homeTeam.name) && !(am.awayTeam && am.awayTeam.name);
    var apiStage = _apiStageKey(am.stage);
    var apiIsKO = apiStage && apiStage !== 'G';
    // Safety: never use loose stage/time fallback for KO placeholders.
    // KO placeholders must map by exact FIFA kickoff time in Pass 0; otherwise leave
    // them unmapped until teams are known. This prevents an API placeholder with a
    // wrong kickoff time from being written into the wrong FIFA match slot.
    if (noTeams && apiIsKO) {
      unmapped.push({ id: am.id, home: am.homeTeam && am.homeTeam.name, away: am.awayTeam && am.awayTeam.name, date: am.utcDate, stage: am.stage });
      return;
    }
    var threshold = noTeams ? 1 : 22;
    if (best && bs >= threshold) { map[am.id] = best; used[best.no] = true; }
    else unmapped.push({ id: am.id, home: am.homeTeam && am.homeTeam.name, away: am.awayTeam && am.awayTeam.name, date: am.utcDate, stage: am.stage });
  });

  return { map: map, unmapped: unmapped };
}

function syncFootballData(pin){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; return _syncFootballDataInternal_(); }
function _syncFootballDataInternal_(){
  var out;
  try{
    var token=_props().getProperty('FOOTBALL_DATA_TOKEN'); if(!token) return _recordSync_({ok:false,msg:'Missing football-data.org API token'});
    var res=UrlFetchApp.fetch('https://api.football-data.org/v4/competitions/WC/matches',{method:'get',headers:{'X-Auth-Token':token},muteHttpExceptions:true});
    if(res.getResponseCode()!==200) return _recordSync_({ok:false,msg:'API error '+res.getResponseCode()+': '+res.getContentText().slice(0,300)});
    var data=JSON.parse(res.getContentText()), ss=_ss(); if(!ss) return _recordSync_({ok:false,msg:'League not set up'});
    var matches=_canonicalMatchesForApiMapping_(), mapped=_mapApiMatches(data.matches||[],matches), ko={}, results={}, liveScores={};
    (data.matches||[]).forEach(function(am){
      var mm=mapped.map[am.id]; if(!mm) return;
      var home=am.homeTeam&&am.homeTeam.name||'', away=am.awayTeam&&am.awayTeam.name||'';
      if(home||away||am.utcDate) {
        // Use the FIFA/internal kickoff time for KO slots. football-data.org can
        // occasionally expose duplicate/wrong KO placeholder times; letting that
        // overwrite our schedule would move locks/bets to the wrong time.
        var safeIso = Number(mm.no) >= 73 ? mm.iso : (am.utcDate || mm.iso);
        ko[mm.no]={h:home||mm.h,a:away||mm.a,iso:safeIso,stage:mm.stage};
      }
      if(am.status==='FINISHED'){
        var sc=_apiScore(am);
        if(sc.hg!=null&&sc.ag!=null) results[mm.no]={hg:sc.hg,ag:sc.ag,w:_winnerFromApi(am),pen:sc.pen};
      }
      if(am.status==='IN_PLAY'||am.status==='PAUSED'||am.status==='HALFTIME'||am.status==='EXTRA_TIME'||am.status==='PENALTY_SHOOTOUT'){
        var sc2=am.score||{}, ft=sc2.fullTime||{}, ht=sc2.halfTime||{};
        var hg=ft.home!=null?ft.home:ht.home, ag=ft.away!=null?ft.away:ht.away;
        // Live score + status only (drives the red LIVE badge). No minute shown.
        if(hg!=null&&ag!=null) liveScores[mm.no]={hg:hg,ag:ag,status:am.status};
      }
    });
    // Honor manual locks: never let the API overwrite a pinned match (e.g. one the
    // admin corrected because football-data had it wrong).
    var locks=_readResultLocks();
    locks.forEach(function(no){ delete results[no]; delete ko[no]; });
    // Locked: same reason as adminSaveResults — this trigger fires every minute
    // during a live match (exactly when players are placing/cancelling bets),
    // and _writeResults_ can settle bets on the same sheet those calls touch.
    var lock=LockService.getScriptLock(); lock.waitLock(10000);
    try{ _writeKO_(ss,ko,true); _writeResults_(ss,results,true); } finally { lock.releaseLock(); }
    _props().setProperty('LIVE_SCORES', JSON.stringify(liveScores)); // cleared each sync; empty when no live match
    out={ok:true,mapped:Object.keys(mapped.map).length,updatedMatches:Object.keys(ko).length,updatedResults:Object.keys(results).length,locked:locks,liveCount:Object.keys(liveScores).length,unmapped:mapped.unmapped.slice(0,20)};
  }catch(e){ out={ok:false,msg:'Sync failed: '+(e&&e.message||String(e))}; }
  return _recordSync_(out);
}
// ── Live scores (IN_PLAY / PAUSED) ───────────────────────────────────────
// Stored separately from final results so the leaderboard never moves mid-game.
// Written by the sync, returned in getState, consumed by the client for display only.
function _getLiveScores(){ try{ return JSON.parse(_props().getProperty('LIVE_SCORES')||'{}'); }catch(e){ return {}; } }

// Lightweight endpoint for the client's live-refresh poll. Live scores come from
// Script Properties and results from a shared 55s cache, so the spreadsheet is
// read at most ~once a minute in total no matter how many clients are polling.
// (_cacheBust() clears results_v1 the moment a result is saved or deleted.)
function getLive(){
  var results=null, cj=null;
  try{ cj=_cache().get('results_v1'); }catch(e){}
  if(cj){ try{ results=JSON.parse(cj); }catch(e){} }
  if(!results){
    var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
    results=_readResults(ss);
    try{ _cache().put('results_v1', JSON.stringify(results), 55); }catch(e){}
  }
  return {ok:true, serverNow:Date.now(), v:_appVersion_(), results:results, resultTimes:_readResultFinishedTimes_(), liveScores:_getLiveScores()};
}

function _recordSync_(r){
  try{
    _props().setProperty('LAST_SYNC_AT',String(Date.now()));
    _props().setProperty('LAST_SYNC_MSG', r.ok ? ('OK · mapped '+(r.mapped||0)+' · results '+(r.updatedResults||0)+' · unmapped '+((r.unmapped||[]).length)) : String(r.msg||'error'));
  }catch(e){}
  return r;
}
function getApiSyncStatus(pin){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; var at=Number(_props().getProperty('LAST_SYNC_AT')||0); return {ok:true,hasToken:!!_props().getProperty('FOOTBALL_DATA_TOKEN'),autoSync:_props().getProperty('AUTO_SYNC')==='1',lastSyncAt:at||null,lastSyncMsg:_props().getProperty('LAST_SYNC_MSG')||'',appVersion:_appVersion_()}; }
function enableAutoSync(pin){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='autoSyncFootballData') ScriptApp.deleteTrigger(t); }); ScriptApp.newTrigger('autoSyncFootballData').timeBased().everyMinutes(1).create(); _props().setProperty('AUTO_SYNC','1'); return {ok:true}; }
function disableAutoSync(pin){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='autoSyncFootballData') ScriptApp.deleteTrigger(t); }); _props().deleteProperty('AUTO_SYNC'); return {ok:true}; }
function autoSyncFootballData(){
  try{
    // Smart skip: only call the API when at least one match is within its live window
    // (kickoff − 5min to kickoff + stage window: 3h group / 3h30 KO / 4h final).
    // Outside that window, return instantly so the 1-minute trigger costs almost nothing.
    var ss=_ss(); if(!ss){ _recordSync_({ok:true,msg:'skip:no-league'}); return; }
    var now=Date.now(), LIVE_BEFORE=5*60*1000;
    var matches=_matches(ss), results=_readResults(ss);
    var hasLiveWindow=matches.some(function(m){
      if(results[m.no]) return false;           // already finished
      var t=new Date(m.iso||'').getTime();
      if(isNaN(t)) return false;
      // Stage-aware live window — accounts for stoppage time, halftime, ET, penalties, ceremonies
      // Group (1-72): 3h | KO non-Final (73-103): 3h30 | Final (104): 4h
      var no=Number(m.no||0);
      var LIVE_AFTER = no===104 ? 240*60*1000 : no>=73 ? 210*60*1000 : 180*60*1000;
      return now>=(t-LIVE_BEFORE) && now<=(t+LIVE_AFTER);
    });
    if(!hasLiveWindow){ _recordSync_({ok:true,msg:'skip:no-live-window'}); return; }
    return _syncFootballDataInternal_();
  }catch(e){ return _recordSync_({ok:false,msg:String(e&&e.message||e)}); }
}

function _readChampion(ss){
  var sh=_sheet(ss,'champion',['key','value']);
  var v=sh.getDataRange().getValues(), winner='', picks={}, pickPublic={};
  for(var i=1;i<v.length;i++){
    var k=String(v[i][0]);
    if(k==='winner') winner=String(v[i][1]||'');
    else if(k.indexOf('pickPublic:')==0){ var pidp=Number(k.slice(11)); if(pidp) pickPublic[pidp]=String(v[i][1]||''); }
    else if(k.indexOf('pick:')==0){ var pid=Number(k.slice(5)); if(pid) picks[pid]=String(v[i][1]||''); }
  }
  return {winner:winner, picks:picks, pickPublic:pickPublic};
}

// Freeze each player's CURRENT pick as their "public/original" pick the moment we
// cross the early lock (June 19 23:59). Idempotent and non-destructive: only adds
// pickPublic:<id> rows that don't exist yet, and never touches live pick:<id>.
function _ensureChampionPublic_(ss){
  var data=_readChampion(ss);
  if(Date.now() < new Date(CHAMPION_LOCK_ISO).getTime()) return data; // still in the free early window
  // Once the switch window has closed, picks can never change again, so after one
  // successful freeze past that moment this becomes a pure read forever (no
  // second sheet scan, no append attempts on every getState).
  var done=null; try{ done=_props().getProperty('CHAMP_PUBLIC_DONE'); }catch(e){}
  if(done) return data;
  var sh=null;
  Object.keys(data.picks).forEach(function(pid){
    if(data.picks[pid] && !data.pickPublic[pid]){
      if(!sh) sh=_sheet(ss,'champion',['key','value']);
      sh.appendRow(['pickPublic:'+pid, data.picks[pid]]);
      data.pickPublic[pid]=data.picks[pid];
    }
  });
  if(Date.now() >= new Date(CHAMPION_SWITCH_ISO).getTime()){ try{ _props().setProperty('CHAMP_PUBLIC_DONE','1'); }catch(e){} }
  return data;
}
function _writeChampionPick_(ss,playerId,team){
  var sh=_sheet(ss,'champion',['key','value']); var v=sh.getDataRange().getValues(); var key='pick:'+playerId;
  for(var i=1;i<v.length;i++){ if(v[i][0]===key){sh.getRange(i+1,2).setValue(team);return;} }
  sh.appendRow([key,team]);
}
function _writeChampionWinner_(ss,team){
  var sh=_sheet(ss,'champion',['key','value']); var v=sh.getDataRange().getValues();
  for(var i=1;i<v.length;i++){ if(v[i][0]==='winner'){sh.getRange(i+1,2).setValue(team);return;} }
  sh.appendRow(['winner',team]);
}

function saveChampionPick(playerId,pin,team){
  team=String(team||'').trim(); playerId=Number(playerId);
  if(!team) return {ok:false,msg:'Choose a team'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var player=null; _readPlayers(ss).forEach(function(p){ if(p.id===playerId) player=p; });
  if(!player||player.pin!==String(pin)) return {ok:false,msg:'Session expired'};
  var now=Date.now();
  var earlyLock=new Date(CHAMPION_LOCK_ISO).getTime();
  var switchLock=new Date(CHAMPION_SWITCH_ISO).getTime();
  if(now >= switchLock) return {ok:false,msg:'Champion pick is locked'};
  var lock=LockService.getScriptLock(); lock.waitLock(10000);
  try{
    // Freeze originals first (no-op before the early lock, and after the first
    // call past it). This guarantees a player's June-19 pick is captured before
    // any post-deadline edit overwrites their live pick.
    _ensureChampionPublic_(ss);
    _writeChampionPick_(ss,playerId,team);
    var champ=_readChampion(ss);
    var original=champ.pickPublic[playerId]||'';
    // During the switch window the change is silent (others still see the frozen
    // original until the July-4 reveal). Value = +20 if final equals original,
    // else +10. Before the early lock there is no original yet → +20.
    var changed = (now>=earlyLock) && (!original || team!==original);
    var value = changed ? CHAMPION_BONUS_SWITCHED : CHAMPION_BONUS_EARLY;
    return {ok:true, team:team, phase:(now<earlyLock?'early':'switch'), value:value, changed:changed, original:original};
  } finally{ lock.releaseLock(); }
}

function adminSetChampionWinner(pin,team){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  team=String(team||'').trim(); if(!team) return {ok:false,msg:'Choose a team'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  _ensureChampionPublic_(ss); // guarantee June-19 originals are frozen before scoring
  _writeChampionWinner_(ss,team); _boardTouch_(); return {ok:true,team:team};
}

function getChampionLeaderboard(){
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var data=_readChampion(ss); if(!data.winner) return {ok:true,winner:'',rows:[]};
  var players=_readPlayers(ss), rows=[];
  players.forEach(function(p){
    var pick=data.picks[p.id]||'';
    var original=data.pickPublic[p.id]||'';
    var changed=pick&&((!original)||(pick!==original));
    var correct=pick&&pick===data.winner?true:false;
    rows.push({id:p.id,name:p.name,pick:pick,correct:correct,changed:!!changed,value:correct?(changed?CHAMPION_BONUS_SWITCHED:CHAMPION_BONUS_EARLY):0});
  });
  rows.sort(function(a,b){ return (b.correct?1:0)-(a.correct?1:0)||a.name.localeCompare(b.name); });
  return {ok:true,winner:data.winner,rows:rows};
}


// Bracket propagation map: source match no → [{target, side:'h'|'a', kind:'W'|'L'}]
var _KO_PROPAGATE = {
  73:[{t:90,s:'h',k:'W'}], 74:[{t:89,s:'h',k:'W'}], 75:[{t:90,s:'a',k:'W'}],
  76:[{t:91,s:'h',k:'W'}], 77:[{t:89,s:'a',k:'W'}], 78:[{t:91,s:'a',k:'W'}],
  79:[{t:92,s:'h',k:'W'}], 80:[{t:92,s:'a',k:'W'}], 81:[{t:94,s:'h',k:'W'}],
  82:[{t:94,s:'a',k:'W'}], 83:[{t:93,s:'h',k:'W'}], 84:[{t:93,s:'a',k:'W'}],
  85:[{t:96,s:'h',k:'W'}], 86:[{t:95,s:'h',k:'W'}], 87:[{t:96,s:'a',k:'W'}],
  88:[{t:95,s:'a',k:'W'}],
  89:[{t:97,s:'h',k:'W'}], 90:[{t:97,s:'a',k:'W'}], 91:[{t:99,s:'h',k:'W'}],
  92:[{t:99,s:'a',k:'W'}], 93:[{t:98,s:'h',k:'W'}], 94:[{t:98,s:'a',k:'W'}],
  95:[{t:100,s:'h',k:'W'}],96:[{t:100,s:'a',k:'W'}],
  97:[{t:101,s:'h',k:'W'}],
  98:[{t:101,s:'a',k:'W'}],
  99:[{t:102,s:'h',k:'W'}],
 100:[{t:102,s:'a',k:'W'}],
 101:[{t:103,s:'h',k:'L'},{t:104,s:'h',k:'W'}],
 102:[{t:103,s:'a',k:'L'},{t:104,s:'a',k:'W'}]
};

function _propagateKOTeams(ss, changedNos, results) {
  // changedNos: array of match numbers whose results just changed
  // For each changed match, resolve its W/L refs in downstream slots
  var ko = _readKO(ss);
  var koUpdates = {};

  // Build a full name map: matchNo -> {h: actualTeamName, a: actualTeamName}
  // by merging MATCHES with ko overrides
  var nameMap = {};
  MATCHES.forEach(function(m) {
    var merged = _mergedMatch(m, ko);
    nameMap[m.no] = {h: merged.h, a: merged.a};
  });

  function resolveTeam(srcNo, kind) {
    var r = results[srcNo];
    if (!r) return null;
    var teams = nameMap[srcNo];
    if (!teams) return null;
    var winner = _actualWinner(r); // 'H' or 'A'
    if (!winner || winner === 'D') return null;
    if (kind === 'W') return winner === 'H' ? teams.h : teams.a;
    if (kind === 'L') return winner === 'H' ? teams.a : teams.h;
    return null;
  }

  changedNos.forEach(function(no) {
    var slots = _KO_PROPAGATE[no];
    if (!slots) return;
    slots.forEach(function(slot) {
      var teamName = resolveTeam(no, slot.k);
      if (!teamName) return;
      koUpdates[slot.t] = koUpdates[slot.t] || {};
      koUpdates[slot.t][slot.s] = teamName;
    });
  });

  if (Object.keys(koUpdates).length === 0) return;

  // Apply updates into the ko table
  Object.keys(koUpdates).forEach(function(targetNo) {
    targetNo = Number(targetNo);
    var cur = ko[targetNo] || {};
    var upd = koUpdates[targetNo];
    if (upd.h) cur.h = upd.h;
    if (upd.a) cur.a = upd.a;
    ko[targetNo] = cur;
  });

  // Persist
  var rows = [];
  Object.keys(ko).sort(function(a,b){return Number(a)-Number(b);}).forEach(function(no) {
    var k = ko[no];
    if (k && (k.h || k.a || k.iso || k.stage))
      rows.push([Number(no), k.h||'', k.a||'', k.iso||'', k.stage||'']);
  });
  var sh = _sheet(ss, 'ko', ['no','home','away','iso','stage']);
  sh.clearContents(); sh.appendRow(['no','home','away','iso','stage']);
  if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
}

// Recompute every propagation-fed slot (matches 89..104) from scratch using the
// current results, processing sources in ascending order so multi-round chains
// resolve correctly. Used after a result is DELETED, so downstream teams that the
// removed result had pushed forward revert to their placeholders (e.g. "W73")
// instead of lingering as a stale, now-wrong team. Only touches home/away of
// matches 89..104 (the only propagation targets); never alters iso/stage or the
// manually/API-set teams of matches 73..88.
function _rebuildPropagatedSlots_(ss) {
  var results = _readResults(ss), ko = _readKO(ss);
  var nameMap = {};
  MATCHES.forEach(function(m) { nameMap[m.no] = {h: m.h, a: m.a}; });
  // Overlay manual/API team names for non-target matches so their winners resolve.
  Object.keys(ko).forEach(function(no) {
    no = Number(no);
    if (no < 89) {
      if (ko[no].h) nameMap[no].h = ko[no].h;
      if (ko[no].a) nameMap[no].a = ko[no].a;
    }
  });
  function winnerName(srcNo, kind) {
    var r = results[srcNo]; if (!r) return null;
    var w = _actualWinner(r); if (w !== 'H' && w !== 'A') return null;
    var teams = nameMap[srcNo]; if (!teams) return null;
    if (kind === 'W') return w === 'H' ? teams.h : teams.a;
    return w === 'H' ? teams.a : teams.h; // 'L'
  }
  var resolved = {};
  Object.keys(_KO_PROPAGATE).map(Number).sort(function(a,b){return a-b;}).forEach(function(src) {
    _KO_PROPAGATE[src].forEach(function(slot) {
      var nm = winnerName(src, slot.k); if (!nm) return;
      resolved[slot.t] = resolved[slot.t] || {}; resolved[slot.t][slot.s] = nm;
      nameMap[slot.t] = nameMap[slot.t] || {}; nameMap[slot.t][slot.s] = nm; // feed downstream
    });
  });
  for (var t = 89; t <= 104; t++) {
    ko[t] = ko[t] || {};
    var rh = resolved[t] && resolved[t].h, ra = resolved[t] && resolved[t].a;
    if (rh) ko[t].h = rh; else delete ko[t].h;
    if (ra) ko[t].a = ra; else delete ko[t].a;
  }
  var rows = [];
  Object.keys(ko).sort(function(a,b){return Number(a)-Number(b);}).forEach(function(no) {
    var k = ko[no];
    if (k && (k.h || k.a || k.iso || k.stage))
      rows.push([Number(no), k.h||'', k.a||'', k.iso||'', k.stage||'']);
  });
  var sh = _sheet(ss, 'ko', ['no','home','away','iso','stage']);
  sh.clearContents(); sh.appendRow(['no','home','away','iso','stage']);
  if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
  _cacheBust();
}

function adminGetFullMatrix(pin){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var players=_readPlayers(ss), allPreds=_readPreds(ss), results=_readResults(ss), matches=_matches(ss);
  var map={}; matches.forEach(function(m){map[m.no]=m;});
  var rows=players.map(function(p){
    var cells={}, total=0;
    matches.forEach(function(m){
      var pr=(allPreds[p.id]||{})[m.no]; if(!pr){cells[m.no]=null;return;}
      var r=results[m.no]||null;
      var s=r?_scoreOne(pr,r,m):{points:null};
      cells[m.no]={pred:pr,points:s.points,exact:s.exact,outcome:s.outcome,wrong:s.wrong,incomplete:s.incomplete,missingWinner:s.missingWinner};
      if(s.points!=null&&!s.incomplete) total+=s.points;
    });
    return {id:p.id,name:p.name,total:total,cells:cells};
  });
  rows.sort(function(a,b){return b.total-a.total||a.name.localeCompare(b.name);});
  return {ok:true,players:rows,matches:matches.map(function(m){return {no:m.no,stage:m.stage,h:m.h,a:m.a,iso:m.iso,result:results[m.no]||null};})};
}


/* ═══════════════════════════════════════════════════════════════
   BETTING SYSTEM
   - R16+ only (matchNo >= 89)
   - Prediction scoring always applies; bets are an additional bonus/risk
   - Parimutuel odds: winners split the total pool proportionally
   - Min 1 pt, max 50% of current balance (or ALL IN on Final #104)
   - Points deducted immediately; payout credited when result saved
   - Wallet = prediction points + betting gains/losses (integrated)
═══════════════════════════════════════════════════════════════ */
function _readBets(ss) {
  var sh = _sheet(ss, 'bets', ['playerId','matchNo','team','amount','settled','payout']);
  var v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    out.push({
      playerId: Number(v[i][0]),
      matchNo:  Number(v[i][1]),
      team:     String(v[i][2] || ''),
      amount:   Number(v[i][3] || 0),
      settled:  v[i][4] === true || String(v[i][4]).toLowerCase() === 'true',
      payout:   Number(v[i][5] || 0)
    });
  }
  return out;
}

function _playerBalance(playerId, players, results, preds, matches, bets, adjs, champ) {
  adjs = adjs || [];
  var map = {}; matches.forEach(function(m) { map[m.no] = m; });

  // 1) Prediction points folded in CHRONOLOGICAL order with a TRUE RESET at 0.
  //    KO penalties are the only thing that can push a wallet negative; the moment
  //    it would drop below 0 it resets to 0, so there is no hidden debt to climb
  //    out of — you simply earn back up from 0.
  var scored = [];
  Object.keys(results).forEach(function(no) {
    var pr = (preds[playerId] || {})[no]; if (!pr) return;
    var s = _scoreOne(pr, results[no], map[no] || {stage: ''});
    if (s.incomplete) return;
    var iso = (map[no] && map[no].iso) || '';
    scored.push({ t: (new Date(iso).getTime() || 0), pts: s.points });
  });
  scored.sort(function(a, b) { return a.t - b.t; });
  var wallet = 0;
  scored.forEach(function(e) { wallet += e.pts; if (wallet < 0) wallet = 0; });

  // 2) Betting wallet: deduct placed stakes, add settled payouts.
  var betPts = 0;
  bets.forEach(function(b) {
    if (b.playerId !== playerId) return;
    betPts -= b.amount;
    if (b.settled) betPts += b.payout;
  });

  // 3) Manual admin adjustments.
  var adjPts = 0;
  adjs.forEach(function(a) { if (a.playerId === playerId) adjPts += a.amount; });

  // 4) Champion: +20 if your final pick equals your frozen June-19 original,
  //    +10 if you changed it during the window (or first-picked after the lock).
  var champPts = 0;
  if (champ && champ.winner) {
    var pick = champ.picks && champ.picks[playerId];
    if (pick) {
      if (pick === champ.winner) {
        var original = (champ.pickPublic && champ.pickPublic[playerId]) || '';
        var changed = (!original) || (pick !== original);
        champPts = changed ? CHAMPION_BONUS_SWITCHED : CHAMPION_BONUS_EARLY;
      } else {
        champPts = -CHAMPION_MISS_PENALTY;
      }
    }
  }

  // Final zero floor: a player's total can never drop below 0.
  return Math.max(0, _round2(wallet + betPts + adjPts + champPts));
}

function placeBet(playerId, pin, matchNo, team, amount) {
  playerId = Number(playerId); matchNo = Number(matchNo); amount = Number(amount);
  if (!team) return {ok: false, msg: 'Choose a team'};
  if (matchNo < 89) return {ok: false, msg: 'Betting is only available from Round of 16 onwards'};
  if (team !== 'H' && team !== 'A') return {ok: false, msg: 'Invalid team selection'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var player = null; _readPlayers(ss).forEach(function(p) { if (p.id === playerId) player = p; });
  if (!player || player.pin !== String(pin)) return {ok: false, msg: 'Session expired'};

  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    // Re-read all state INSIDE the lock so the balance check and the write are
    // atomic. This prevents two simultaneous bets (double-tap / two devices)
    // from both passing the affordability check and overspending the balance.
    var results = _readResults(ss), matches = _matches(ss), preds = _readPreds(ss);
    if (!_bettingGateOpen_(results)) return {ok: false, msg: 'Betting opens after Match 87 result is entered'};
    var players = _readPlayers(ss), adjs = _readAdjustments(ss);
    var match = null; matches.forEach(function(m) { if (m.no === matchNo) match = m; });
    if (!match) return {ok: false, msg: 'Match not found'};
    if (results[matchNo]) return {ok: false, msg: 'Match already finished'};
    var now = Date.now(), t = new Date(match.iso).getTime();
    if (isNaN(t) || now >= t - LOCK_MS) return {ok: false, msg: 'Betting is closed for this match'};
    if (!_teamsConfirmed_(match)) return {ok: false, msg: 'Teams not confirmed yet'};

    // You may only bet on the team you predicted to advance in this match.
    // This ties betting to the prediction instead of letting it be an
    // independent free pick.
    var myPreds = preds[playerId] || {};
    var myPick = _cleanPick(myPreds[matchNo] || myPreds[String(matchNo)]);
    if (!myPick) return {ok: false, msg: 'Predict this match before betting on it'};
    var predictedTeam = _predictedWinner(myPick);
    if (predictedTeam !== 'H' && predictedTeam !== 'A') {
      return {ok: false, msg: 'Pick which team advances in your prediction before betting'};
    }
    if (team !== predictedTeam) {
      return {ok: false, msg: 'You can only bet on the team you predicted: ' + (predictedTeam === 'H' ? match.h : match.a)};
    }

    var bets = _readBets(ss);
    // One bet per match per player.
    for (var i = 0; i < bets.length; i++) {
      if (bets[i].playerId === playerId && bets[i].matchNo === matchNo) {
        return {ok: false, msg: 'You already have a bet on this match'};
      }
    }

    var champ = _readChampion(ss);
    var balance = _playerBalance(playerId, players, results, preds, matches, bets, adjs, champ);

    // Aggregate 50% cap: the 50% ceiling is checked against TOTAL open exposure
    // (every currently-unsettled bet this player has, across all matches), not
    // just the single bet being placed. Otherwise a player can legally bet
    // half their balance, then half of what's left, and end up with far more
    // than half committed overall (each individual bet was "legal" in
    // isolation, but the combined exposure wasn't).
    //
    // grossBalance = balance as if no bets were currently open (wallet +
    // settled-bet net effect + adjustments + champion points). It's the stable
    // reference point for "50% of what I actually have" — it moves only when
    // a prediction result changes it or a bet settles, never when a NEW bet is
    // placed, so it can't be gamed by placing bets in a particular order.
    var settledOnly = bets.filter(function(b) { return b.settled; });
    var grossBalance = _playerBalance(playerId, players, results, preds, matches, settledOnly, adjs, champ);
    var openStakes = 0;
    bets.forEach(function(b) { if (b.playerId === playerId && !b.settled) openStakes += b.amount; });

    var isFinal = matchNo === 104;
    var isAllIn = (amount === -1); // sentinel for all-in
    if (isAllIn && !isFinal) return {ok: false, msg: 'All-in is only available for the Final'};
    // Stakes are always whole points. For Final all-in, use every whole point
    // available and leave any fractional payout remainder in the wallet.
    if (isAllIn) { amount = Math.floor(balance); }
    if (!isAllIn && (!isFinite(amount) || Math.floor(amount) !== amount)) {
      return {ok: false, msg: 'Bet amount must be a whole number'};
    }
    if (amount < 1) return {ok: false, msg: 'Minimum bet is 1 point'};
    if (!isFinal) {
      var aggCap = Math.floor(grossBalance * 0.5);
      var remaining = Math.max(0, aggCap - openStakes);
      if (amount > remaining) return {ok: false, msg: 'Maximum bet is ' + remaining + ' points (50% of balance across all open bets)'};
    }
    if (amount > balance) return {ok: false, msg: 'Not enough points (balance: ' + balance + ')'};

    var sh = _sheet(ss, 'bets', ['playerId','matchNo','team','amount','settled','payout']);
    sh.appendRow([playerId, matchNo, team, amount, false, 0]);
    _cacheBust(); _boardTouch_();
    return {ok: true, amount: amount, balance: balance - amount};
  } finally { lock.releaseLock(); }
}

function cancelBet(playerId, pin, matchNo) {
  playerId = Number(playerId); matchNo = Number(matchNo);
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var player = null; _readPlayers(ss).forEach(function(p) { if (p.id === playerId) player = p; });
  if (!player || player.pin !== String(pin)) return {ok: false, msg: 'Session expired'};
  var results = _readResults(ss), matches = _matches(ss);
  var match = null; matches.forEach(function(m) { if (m.no === matchNo) match = m; });
  if (!match) return {ok: false, msg: 'Match not found'};
  if (results[matchNo]) return {ok: false, msg: 'Match already finished — cannot cancel'};
  var now = Date.now(), t = new Date(match.iso).getTime();
  if (!isNaN(t) && now >= t - LOCK_MS) return {ok: false, msg: 'Betting is closed — cannot cancel'};
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = _sheet(ss, 'bets', ['playerId','matchNo','team','amount','settled','payout']);
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (Number(v[i][0]) === playerId && Number(v[i][1]) === matchNo && !v[i][4]) {
        sh.deleteRow(i + 1);
        _cacheBust(); _boardTouch_();
        return {ok: true};
      }
    }
    return {ok: false, msg: 'Bet not found'};
  } finally { lock.releaseLock(); }
}

// ── Admin bet overrides ──────────────────────────────────────────────────
// These bypass all player-facing restrictions (lock, balance, settled check).
// Use them to correct mistakes or handle edge cases during the tournament.

function adminForceCancelBet(pin, playerId, matchNo){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  playerId=Number(playerId); matchNo=Number(matchNo);
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var lock=LockService.getScriptLock(); lock.waitLock(8000);
  try{
    var sh=_sheet(ss,'bets',['playerId','matchNo','team','amount','settled','payout']);
    var v=sh.getDataRange().getValues();
    for(var i=1;i<v.length;i++){
      if(Number(v[i][0])===playerId&&Number(v[i][1])===matchNo){
        sh.deleteRow(i+1); _cacheBust(); _boardTouch_(); return {ok:true};
      }
    }
    return {ok:false,msg:'Bet not found'};
  }finally{ lock.releaseLock(); }
}

function adminSetBetPayout(pin, playerId, matchNo, payout){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  playerId=Number(playerId); matchNo=Number(matchNo); payout=Number(payout);
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var lock=LockService.getScriptLock(); lock.waitLock(8000);
  try{
    var sh=_sheet(ss,'bets',['playerId','matchNo','team','amount','settled','payout']);
    var v=sh.getDataRange().getValues();
    for(var i=1;i<v.length;i++){
      if(Number(v[i][0])===playerId&&Number(v[i][1])===matchNo){
        sh.getRange(i+1,5).setValue(true);
        sh.getRange(i+1,6).setValue(payout);
        _cacheBust(); _boardTouch_(); return {ok:true};
      }
    }
    return {ok:false,msg:'Bet not found'};
  }finally{ lock.releaseLock(); }
}

function adminPlaceBet(pin, playerId, matchNo, team, amount){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  playerId=Number(playerId); matchNo=Number(matchNo); amount=Number(amount);
  if(!team||!amount||amount<1) return {ok:false,msg:'Invalid parameters'};
  var ss=_ss(); if(!ss) return {ok:false,msg:'League not set up'};
  var lock=LockService.getScriptLock(); lock.waitLock(8000);
  try{
    var sh=_sheet(ss,'bets',['playerId','matchNo','team','amount','settled','payout']);
    // check for duplicate (admin replaces existing if any)
    var v=sh.getDataRange().getValues();
    for(var i=1;i<v.length;i++){
      if(Number(v[i][0])===playerId&&Number(v[i][1])===matchNo) sh.deleteRow(i+1);
    }
    sh.appendRow([playerId,matchNo,team,amount,false,0]);
    _cacheBust(); _boardTouch_(); return {ok:true};
  }finally{ lock.releaseLock(); }
}

function _settleBetsForMatch(ss, matchNo, result) {
  // Handles both first settlement AND re-settlement when a result is corrected.
  // Step 1: reset any previously settled bets for this match (unsettled → payout = 0).
  // Step 2: re-settle with the new result.
  var actualWinner = _actualWinner(result); // 'H' or 'A'
  var sh = _sheet(ss, 'bets', ['playerId','matchNo','team','amount','settled','payout']);
  var v = sh.getDataRange().getValues();

  // Pass 1: unsettled all existing settlements for this match
  for (var i = 1; i < v.length; i++) {
    if (Number(v[i][1]) !== matchNo) continue;
    if (v[i][4]) { // was settled — reset it
      sh.getRange(i + 1, 5).setValue(false);
      sh.getRange(i + 1, 6).setValue(0);
    }
  }

  // If result has no clear winner yet (incomplete), stop here —
  // bets stay open (unsettled) until the result is corrected properly.
  if (actualWinner !== 'H' && actualWinner !== 'A') return;

  // Re-read after reset
  v = sh.getDataRange().getValues();
  var rows = [], totalPool = 0, winPool = 0;
  for (var i = 1; i < v.length; i++) {
    if (Number(v[i][1]) !== matchNo || v[i][4]) continue;
    var amt = Number(v[i][3]);
    totalPool += amt;
    if (String(v[i][2]) === actualWinner) winPool += amt;
    rows.push({row: i + 1, team: String(v[i][2]), amount: amt});
  }
  if (!rows.length) return;

  // Whole-number payouts, each rounded independently to the nearest whole
  // point: below .5 rounds down; .5 and above rounds up. This guarantees two
  // identical bets receive identical payouts. If rounding makes total payouts
  // exceed the pool, the house covers the difference; there is deliberately no
  // leftover tie-break based on sheet row order.
  var payouts = new Array(rows.length);
  if (winPool <= 0) {
    // Nobody backed the actual winner — a one-sided pool that guessed wrong.
    // Full refund would make consensus bets risk-free (the loophole we're
    // fixing); full forfeiture can wipe out several players' real standing
    // on the same unlucky match at once (harsh for a friendly league). Half
    // back is the middle ground: still genuinely risky, not devastating.
    for (var j = 0; j < rows.length; j++) payouts[j] = Math.round(rows[j].amount / 2);
  } else {
    // Parimutuel: winners split the pool in proportion to their stake,
    // each share rounded to the nearest whole point on its own; .5 rounds up,
    // and the house pays any rounding excess above the pool.
    for (var j = 0; j < rows.length; j++) {
      payouts[j] = rows[j].team === actualWinner
        ? Math.round((rows[j].amount / winPool) * totalPool)
        : 0;
    }
  }

  // Write payouts
  for (var j = 0; j < rows.length; j++) {
    sh.getRange(rows[j].row, 5).setValue(true);
    sh.getRange(rows[j].row, 6).setValue(payouts[j]);
  }
  _cacheBust();
}

function getBettingState(playerId, pin) {
  playerId = Number(playerId);
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};

  // Public pools are identical for everyone — cache them 60s.
  // (Safe: placeBet/cancelBet/settle all _cacheBust(), so changes show at once.)
  var pools=null, bets=null;
  var cachedPools=null; try{ cachedPools=_cache().get('pools_v1'); }catch(e){}
  if(cachedPools){ try{ pools=JSON.parse(cachedPools); }catch(e){} }

  var players = _readPlayers(ss);
  if(!pools){
    var matches = _matches(ss);
    bets = _readBets(ss);
    var results0 = _readResults(ss);
    var nameById = {}; players.forEach(function(p){ nameById[p.id] = p.name; });
    pools = {};
    matches.forEach(function(m) {
      if (m.no < 89) return;
      var h = 0, a = 0, total = 0, bettors = 0, list = [];
      bets.forEach(function(b) {
        if (b.matchNo !== m.no) return;
        total += b.amount; bettors++;
        if (b.team === 'H') h += b.amount; else a += b.amount;
      });
      // Only reveal who bet what, and their net result, once the match has a
      // final result — keeps in-progress bets private (matches the existing
      // "no team info visible before betting" spirit) while giving a public,
      // settled record afterward. Pool totals above stay visible throughout,
      // same as before.
      if (results0[m.no]) {
        bets.forEach(function(b) {
          if (b.matchNo !== m.no) return;
          list.push({
            name: nameById[b.playerId] || ('P'+b.playerId),
            team: b.team, amount: b.amount, settled: b.settled,
            net: b.settled ? Math.round(b.payout - b.amount) : null
          });
        });
        list.sort(function(x,y){ return (y.net||-Infinity) - (x.net||-Infinity); });
      }
      pools[m.no] = {h: h, a: a, total: total, bettors: bettors, list: list};
    });
    try{ _cache().put('pools_v1', JSON.stringify(pools), 60); }catch(e){}
  }

  var player = null; players.forEach(function(p) { if (p.id === playerId) player = p; });
  var authed = player && player.pin && player.pin === String(pin || '');
  var out = {ok: true, pools: pools};
  if (authed) {
    if(!bets) bets = _readBets(ss);
    var results = _readResults(ss), preds = _readPreds(ss), matches2 = _matches(ss);
    var balance = _playerBalance(playerId, players, results, preds, matches2, bets, _readAdjustments(ss), _readChampion(ss));
    var myBets = {};
    bets.forEach(function(b) { if (b.playerId === playerId) myBets[b.matchNo] = b; });
    out.balance = balance;
    out.myBets = myBets;
  }
  return out;
}

function getBettingLeaderboard() {
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var players = _readPlayers(ss), results = _readResults(ss);
  var preds = _readPreds(ss), matches = _matches(ss), bets = _readBets(ss);
  var adjs = _readAdjustments(ss);
  var champ = _readChampion(ss);
  var rows = players.map(function(p) {
    var balance = _playerBalance(p.id, players, results, preds, matches, bets, adjs, champ);
    var betWon = 0, betLost = 0, betPending = 0;
    bets.forEach(function(b) {
      if (b.playerId !== p.id) return;
      if (!b.settled) { betPending += b.amount; return; }
      var net = b.payout - b.amount;
      if (net >= 0) betWon += net; else betLost += Math.abs(net);
    });
    return {id: p.id, name: p.name, balance: balance, betWon: _round2(betWon), betLost: _round2(betLost), betPending: betPending};
  });
  rows.sort(function(a, b) { return b.balance - a.balance || a.name.localeCompare(b.name); });
  return {ok: true, rows: rows};
}

function adminSettleBet(pin, playerId, matchNo) {
  // Manual settlement override for admin
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try{
    var results = _readResults(ss);
    if (!results[matchNo]) return {ok: false, msg: 'No result for match #' + matchNo};
    _settleBetsForMatch(ss, Number(matchNo), results[matchNo]);
    _boardTouch_();
    return {ok: true};
  } finally { lock.releaseLock(); }
}

// Resets every bet on a match back to pending/payout 0, WITHOUT touching the
// stored result (unlike adminDeleteResult, which wipes the score too). Lets
// admin pull a match's bets back for review/correction before re-settling
// with "Settle", e.g. if a payout looks wrong and needs a closer look first.
function adminUnsettleBet(pin, matchNo) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  matchNo = Number(matchNo);
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try{
    var sh = _sheet(ss, 'bets', ['playerId','matchNo','team','amount','settled','payout']);
    var v = sh.getDataRange().getValues(), count = 0;
    for (var i = 1; i < v.length; i++) {
      if (Number(v[i][1]) !== matchNo) continue;
      if (v[i][4]) { sh.getRange(i + 1, 5).setValue(false); sh.getRange(i + 1, 6).setValue(0); count++; }
    }
    if (count) { _cacheBust(); _boardTouch_(); }
    return {ok: true, unsettled: count};
  } finally { lock.releaseLock(); }
}

function adminGetBets(pin) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var bets = _readBets(ss), players = _readPlayers(ss), matches = _matches(ss), preds = _readPreds(ss);
  var playerMap = {}, matchMap = {};
  players.forEach(function(p) { playerMap[p.id] = p.name; });
  matches.forEach(function(m) { matchMap[m.no] = m; });
  var rows = bets.map(function(b) {
    var m = matchMap[b.matchNo] || {};
    // Diagnostic only: cross-check this bet against the player's CURRENT
    // prediction for the same match. A mismatch here means the bet predates
    // the "bet only on your predicted team" rule (or the prediction changed
    // after a result already locked the match) — flag it for manual review,
    // don't auto-touch it.
    var myPreds = preds[b.playerId] || {};
    var myPick = _cleanPick(myPreds[b.matchNo] || myPreds[String(b.matchNo)]);
    var predTeam = myPick ? _predictedWinner(myPick) : '';
    var mismatch = !b.settled && predTeam !== b.team;
    return {
      playerId: b.playerId,
      playerName: playerMap[b.playerId] || 'P'+b.playerId,
      matchNo: b.matchNo, stage: m.stage || '',
      h: m.h || '', a: m.a || '',
      team: b.team, amount: b.amount,
      settled: b.settled, payout: b.payout,
      net: b.settled ? _round2(b.payout - b.amount) : null,
      predTeam: predTeam, mismatch: mismatch
    };
  });
  var mismatchCount = rows.filter(function(r){ return r.mismatch; }).length;
  return {ok: true, bets: rows, mismatchCount: mismatchCount};
}


function _readAdjustments(ss) {
  var sh = _sheet(ss, 'adjustments', ['playerId','amount','reason','adminNote','ts']);
  var v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    out.push({
      playerId: Number(v[i][0]),
      amount:   Number(v[i][1] || 0),
      reason:   String(v[i][2] || ''),
      note:     String(v[i][3] || ''),
      ts:       Number(v[i][4] || 0)
    });
  }
  return out;
}

function adminAdjustPoints(pin, playerId, amount, reason, note) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  playerId = Number(playerId);
  amount = Number(amount);
  if (isNaN(amount) || amount === 0) return {ok: false, msg: 'Amount cannot be zero'};
  reason = String(reason || 'manual').trim() || 'manual';
  note   = String(note   || '').trim();
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var player = null; _readPlayers(ss).forEach(function(p) { if (p.id === playerId) player = p; });
  if (!player) return {ok: false, msg: 'Player not found'};
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    _sheet(ss, 'adjustments', ['playerId','amount','reason','adminNote','ts'])
      .appendRow([playerId, amount, reason, note, Date.now()]);
    _cacheBust(); _boardTouch_();
    return {ok: true, name: player.name, amount: amount};
  } finally { lock.releaseLock(); }
}

function adminDeleteAdjustment(pin, playerId, ts) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var sh = _sheet(ss, 'adjustments', ['playerId','amount','reason','adminNote','ts']);
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (Number(v[i][0]) === Number(playerId) && Number(v[i][4]) === Number(ts)) {
      sh.deleteRow(i + 1);
      _boardTouch_();
      return {ok: true};
    }
  }
  return {ok: false, msg: 'Adjustment not found'};
}

function adminGetAdjustments(pin) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var adjs = _readAdjustments(ss), players = _readPlayers(ss), nameMap = {};
  players.forEach(function(p) { nameMap[p.id] = p.name; });
  return {ok: true, adjustments: adjs.map(function(a) {
    return {playerId:a.playerId, name:nameMap[a.playerId]||'P'+a.playerId,
            amount:a.amount, reason:a.reason, note:a.note, ts:a.ts};
  }).reverse()}; // newest first
}


function adminGetHiddenTabs(pin) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  try {
    var val = _props().getProperty('HIDDEN_TABS') || '[]';
    return {ok: true, hidden: JSON.parse(val)};
  } catch(e) { return {ok: true, hidden: []}; }
}

function adminSetHiddenTabs(pin, tabs) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  _props().setProperty('HIDDEN_TABS', JSON.stringify(tabs || []));
  return {ok: true, hidden: tabs || []};
}


function adminDebugSync(pin) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var token = _props().getProperty('FOOTBALL_DATA_TOKEN');
  if (!token) return {ok: false, msg: 'No token'};
  var res = UrlFetchApp.fetch('https://api.football-data.org/v4/competitions/WC/matches',
    {method:'get', headers:{'X-Auth-Token': token}, muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) return {ok: false, msg: 'API error ' + res.getResponseCode()};
  var data = JSON.parse(res.getContentText());
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var matches = _canonicalMatchesForApiMapping_();
  var mapped = _mapApiMatches(data.matches || [], matches);

  // For unmapped API matches, show top scoring candidates
  var details = mapped.unmapped.map(function(um) {
    var apiMatch = null;
    (data.matches || []).forEach(function(m) { if (m.id === um.id) apiMatch = m; });
    if (!apiMatch) return um;
    var scores = [];
    matches.forEach(function(m) {
      var s = _matchScoreFor(apiMatch, m);
      if (s > 0) scores.push({no: m.no, h: m.h, a: m.a, score: s});
    });
    scores.sort(function(a,b){return b.score-a.score;});
    return {
      apiId: um.id,
      apiHome: apiMatch.homeTeam && apiMatch.homeTeam.name,
      apiAway: apiMatch.awayTeam && apiMatch.awayTeam.name,
      apiStage: apiMatch.stage,
      apiGroup: apiMatch.group,
      apiDate: apiMatch.utcDate,
      normHome: _norm(apiMatch.homeTeam && apiMatch.homeTeam.name),
      normAway: _norm(apiMatch.awayTeam && apiMatch.awayTeam.name),
      topCandidates: scores.slice(0, 5)
    };
  });
  // Full KO mapping (nos 73-104) so admin can verify each match mapped correctly
  var koMapping = [];
  Object.keys(mapped.map).forEach(function(apiId) {
    var mm = mapped.map[apiId];
    if (mm.no < 73) return;
    var am = null; (data.matches||[]).forEach(function(x){ if(String(x.id)===String(apiId)) am=x; });
    if (!am) return;
    koMapping.push({
      ourNo: mm.no, ourH: mm.h, ourA: mm.a,
      apiDate: am.utcDate,
      apiHome: am.homeTeam&&am.homeTeam.name||'',
      apiAway: am.awayTeam&&am.awayTeam.name||''
    });
  });
  koMapping.sort(function(a,b){return a.ourNo-b.ourNo;});
  return {ok: true, totalApi: (data.matches||[]).length, totalOurs: matches.length, mapped: Object.keys(mapped.map).length, unmappedCount: mapped.unmapped.length, koMapping: koMapping, details: details};
}


function _currentLeaderIds(ss){
  var results = _readResults(ss), preds = _readPreds(ss);
  var matches = _matches(ss), bets = _readBets(ss), adjs = _readAdjustments(ss);
  var players = _readPlayers(ss), champ = _readChampion(ss);
  var scores = players.map(function(p) {
    return {id: p.id, pts: _playerBalance(p.id, players, results, preds, matches, bets, adjs, champ)};
  });
  scores.sort(function(a,b){return b.pts-a.pts;});
  if (!scores.length) return [];
  var topPts = scores[0].pts;
  return scores.filter(function(s){return s.pts===topPts;}).map(function(s){return s.id;});
}

function saveLeaderMessage(playerId, pin, msg) {
  playerId = Number(playerId);
  msg = String(msg || '').trim().slice(0, 140);
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var player = null; _readPlayers(ss).forEach(function(p) { if (p.id === playerId) player = p; });
  if (!player || player.pin !== String(pin || '')) return {ok: false, msg: 'Session expired'};

  var leaderIds = _currentLeaderIds(ss);
  // Throne disabled when more than 3 are tied for 1st
  if (leaderIds.length > 3) return {ok: false, msg: 'Throne message is disabled while more than 3 players are tied for 1st'};
  if (leaderIds.indexOf(playerId) < 0) return {ok: false, msg: 'Only the current leader (or tied leaders) can post a message'};

  // Find next upcoming match kickoff time (messages expire then)
  var results = _readResults(ss), ko = _readKO(ss), now = Date.now(), nextKickoff = null;
  _matches(ss).forEach(function(m) {
    var merged = _mergedMatch(m, ko);
    var t = new Date(merged.iso || '').getTime();
    if (!isNaN(t) && t > now && !results[m.no]) {
      if (nextKickoff === null || t < nextKickoff) nextKickoff = t;
    }
  });
  var expires = nextKickoff || (Date.now() + 86400000);

  // Store per-player message map
  var raw = _props().getProperty('LEADER_MSGS') || '{}';
  var map = {}; try { map = JSON.parse(raw); } catch(e) { map = {}; }
  map[playerId] = { playerId: playerId, name: player.name, msg: msg, ts: Date.now(), expires: expires };
  _props().setProperty('LEADER_MSGS', JSON.stringify(map));
  _boardTouch_();
  return {ok: true};
}

function getLeaderMessage() {
  // Returns a map of playerId -> message for current tied leaders (<=3).
  // Prunes expired messages and messages from players no longer leading.
  try {
    var ss = _ss(); if (!ss) return {ok: true, messages: {}};
    var leaderIds = _currentLeaderIds(ss);
    if (leaderIds.length > 3) return {ok: true, messages: {}, tooMany: true};
    var raw = _props().getProperty('LEADER_MSGS') || '{}';
    var map = {}; try { map = JSON.parse(raw); } catch(e) { map = {}; }
    var now = Date.now(), out = {}, changed = false;
    Object.keys(map).forEach(function(pid) {
      var m = map[pid];
      // keep only if not expired AND still a current leader
      if (m && now <= m.expires && leaderIds.indexOf(Number(pid)) >= 0) {
        out[pid] = m;
      } else { changed = true; }
    });
    if (changed) _props().setProperty('LEADER_MSGS', JSON.stringify(out));
    return {ok: true, messages: out};
  } catch(e) { return {ok: true, messages: {}}; }
}


function adminGetChampionPicks(pin) {
  if (!_adminOK(pin)) return {ok: false, msg: 'Wrong admin PIN'};
  var ss = _ss(); if (!ss) return {ok: false, msg: 'League not set up'};
  var data = _readChampion(ss), players = _readPlayers(ss), nameMap = {};
  players.forEach(function(p) { nameMap[p.id] = p.name; });
  var rows = players.map(function(p) {
    return {id: p.id, name: p.name, pick: data.picks[p.id] || '', correct: data.winner && data.picks[p.id] === data.winner};
  });
  var picked = rows.filter(function(r) { return r.pick; }).length;
  return {ok: true, winner: data.winner || '', rows: rows, picked: picked, total: players.length};
}

function adminGetPredVisibility(pin){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  return {ok:true, mode:_props().getProperty('PRED_VISIBILITY')||'hidden'};
}
function adminSetPredVisibility(pin, mode){
  if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'};
  if(['hidden','anon','named'].indexOf(mode)<0) return {ok:false,msg:'Invalid mode'};
  _props().setProperty('PRED_VISIBILITY', mode);
  _cacheBust();
  return {ok:true, mode:mode};
}

function adminResetLeague(pin,phrase){ if(!_adminOK(pin)) return {ok:false,msg:'Wrong admin PIN'}; if(String(phrase)!=='RESET') return {ok:false,msg:'Type RESET to confirm'}; _props().deleteProperty('ssid'); return {ok:true}; }
