#!/usr/bin/env bash
# Foundry authoring script for the voice-helpdesk ontology (plan U3/U4).
#
# Publishes, in the required order (ontology/README.md section 2, pltr-cli
# ontology-commands.md "Required Publication Order"):
#   1. dataset schemas (datasets subcommand)
#   3. object-type-upsert + object-type-add-property (object-types subcommand)
#   4. link-type-upsert (links subcommand)
#   5. action-type-upsert (action subcommand)
# plus a read-only "verify" subcommand and an "all" subcommand that runs the
# whole sequence.
#
# Safe by construction:
#   - object-type-upsert / link-type-upsert / action-type-upsert are always
#     invoked without --apply unless this script's own --apply flag is given,
#     so pltr performs (and prints) ITS OWN dry-run plan by default.
#   - dataset/folder creation, file upload and schema-set have no CLI-level
#     dry run, so THIS script never calls them unless --apply is given; with
#     no --apply it only prints the command it would run.
#   - every created RID / id is written to state.env and read back on the
#     next run, so re-running any subcommand is safe and resumable.
#
# This script talks to Foundry over the network on every subcommand except
# --help. Confirm connectivity first with:
#   ~/.local/bin/pltr admin user current --profile zap

set -euo pipefail

PLTR="${PLTR:-$HOME/.local/bin/pltr}"
PROFILE="zap"
ONT="ri.ontology.main.ontology.1a944941-d587-4363-8314-d6274b7b0381"
PROJECT_FOLDER_RID="ri.compass.main.folder.9272e104-dd62-4897-9884-ef6a225252da"
ACTION_API_NAME="createHelpdeskIssue"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ONTOLOGY_DIR="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
STATE_FILE="$SCRIPT_DIR/state.env"
ACTION_DEFINITION_FILE="$SCRIPT_DIR/action-create-helpdesk-issue.definition.json"

APPLY=0
SUBCOMMAND=""

usage() {
  cat <<'USAGE'
Usage: author-ontology.sh [--apply] SUBCOMMAND

Subcommands:
  datasets       Create the "Data/Backing Datasets" folder, the four backing
                 datasets (helpdesk_sites, helpdesk_teams, helpdesk_users,
                 helpdesk_issues), upload the seed CSVs, and set their schema.
  object-types   Upsert the four object types (HelpdeskUser, HelpdeskIssue,
                 Site, Team) and add every non-key property to each.
  links          Upsert the three link types (reportedBy, assignedTeam, site).
  action         Upsert the createHelpdeskIssue action type from
                 action-create-helpdesk-issue.definition.json.
  verify         Run the read-only smoke checks from README section 2.4
                 (object-type-list, two object-get, one object-linked).
  all            Run datasets, object-types, links, action, verify in order.

Flags:
  --apply        Actually write changes.
                   - object-type-upsert / link-type-upsert / action-type-upsert
                     are dry-run plans by default (pltr's own --apply flag is
                     appended only when this flag is given).
                   - dataset create / files upload / schema set / folder
                     create have no dry-run mode in pltr, so without --apply
                     this script only PRINTS the command it would run; it
                     never calls pltr for these.
  -h, --help     Show this help and exit (does not touch pltr or the network).

Environment:
  SEED_DIR       Directory holding sites.csv, teams.csv, users.csv, issues.csv.
                 Default: ontology/seed/local (real pepper, gitignored). If
                 that directory does not exist, falls back to ontology/seed
                 (the committed PLACEHOLDER data, placeholder phone and
                 pepper) and prints a loud warning.
  PLTR           Path to the pltr binary. Default: $HOME/.local/bin/pltr
                 (0.29.1). The stale pltr on PATH (0.13.0) is never used.

State:
  ontology/scripts/state.env records every RID and object/link/action type id
  this script creates (HELPDESK_SITES_DATASET_RID=..., OBJECT_TYPE_ID_HELPDESKISSUE=...,
  LINK_TYPE_ID_REPORTEDBY=..., ACTION_TYPE_ID_CREATEHELPDESKISSUE=..., etc). It
  is sourced at the start of every run; anything already recorded there is
  skipped, so re-running any subcommand (including "all") is safe.

Not automated by this script (see ontology/README.md 2.5): value types
(status/priority), title keys on all four object types, the Action's
Security & Submission Criteria group check, the Action log object type
wiring, and the notification rule. These have no CLI surface today and are
done by hand in Ontology Manager.

Every pltr call needs --profile zap and reaches
https://zap.usw-18.palantirfoundry.com. Confirm that works before running
anything here:
  ~/.local/bin/pltr admin user current --profile zap
USAGE
}

log() { printf '>> %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

upper() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]'
}

# json_field JSON KEY -> prints the string/scalar value of KEY in JSON, or
# nothing if absent/null.
json_field() {
  local json="$1" key="$2"
  python3 - "$json" "$key" <<'PY'
import json
import sys

raw = sys.argv[1]
# pltr prints human status lines ("✅ ...", "ℹ️ ...") before the JSON body; parse from the first brace.
start = raw.find("{")
if start < 0:
    print("")
    sys.exit(0)
data = json.JSONDecoder().raw_decode(raw[start:])[0]
value = data.get(sys.argv[2])
print(value if value is not None else "")
PY
}

# json_field_any JSON KEY [KEY...] -> prints the first non-empty match.
json_field_any() {
  local json="$1"
  shift
  local key value
  for key in "$@"; do
    value="$(json_field "$json" "$key")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$STATE_FILE"
    set +a
  fi
}

state_has() {
  local key="$1"
  [[ -n "${!key:-}" ]]
}

state_set() {
  local key="$1" value="$2" tmp
  touch "$STATE_FILE"
  tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
  grep -v "^${key}=" "$STATE_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$STATE_FILE"
  printf -v "$key" '%s' "$value"
}

check_pltr_binary() {
  if [[ ! -x "$PLTR" ]]; then
    die "pltr binary not found or not executable at $PLTR (expected ~/.local/bin/pltr, version 0.29.1). Set PLTR=/path/to/pltr if it lives elsewhere."
  fi
}

# pltr_run ARGS... -> runs "$PLTR" ARGS... --profile "$PROFILE", streaming
# stdout/stderr through (caller captures with $(...) when it needs the body).
# wait_for_object_type API_NAME -> polls the public get endpoint until the new
# type is readable (the ontology index lags modifyOntology by a minute or two;
# adding properties before that fails with ObjectTypeNotFound).
wait_for_object_type() {
  local api_name="$1" i
  for i in $(seq 1 60); do
    # The list endpoint reflects a new type sooner than the get endpoint, and
    # add-property resolves through get, so require both before continuing.
    if "$PLTR" ontology object-type-list "$ONT" --profile "$PROFILE" --format json 2>/dev/null | grep -q "\"api_name\": \"$api_name\"" \
      && "$PLTR" ontology object-type-get "$ONT" "$api_name" --profile "$PROFILE" --format json 2>/dev/null | grep -q '"api_name"'; then
      log "object type $api_name is readable"
      return 0
    fi
    log "waiting for object type $api_name to become readable ($i/24)"
    sleep 10
  done
  die "object type $api_name never became readable; re-run object-types later"
}

pltr_run() {
  log "+ $PLTR $* --profile $PROFILE"
  "$PLTR" "$@" --profile "$PROFILE"
}

resolve_seed_dir() {
  local dir="${SEED_DIR:-}"
  if [[ -n "$dir" ]]; then
    [[ -d "$dir" ]] || die "SEED_DIR=$dir does not exist"
    printf '%s' "$dir"
    return 0
  fi

  local default_dir="$ONTOLOGY_DIR/seed/local"
  local fallback_dir="$ONTOLOGY_DIR/seed"
  if [[ -d "$default_dir" ]]; then
    printf '%s' "$default_dir"
    return 0
  fi

  warn "$default_dir is missing (real seed data, gitignored); falling back to $fallback_dir, which is PLACEHOLDER data (phone +15550100000, pepper 'example-pepper-do-not-use'). Do not upload this anywhere but a throwaway smoke test."
  printf '%s' "$fallback_dir"
}

# ---------------------------------------------------------------------------
# datasets
# ---------------------------------------------------------------------------

cmd_datasets() {
  check_pltr_binary
  local seed_dir
  seed_dir="$(resolve_seed_dir)"
  log "using seed directory: $seed_dir"

  local data_folder_rid
  if state_has DATA_FOLDER_RID; then
    data_folder_rid="$DATA_FOLDER_RID"
    log "Data/Backing Datasets folder already recorded: $data_folder_rid"
  elif [[ "$APPLY" -eq 1 ]]; then
    local out
    out="$(pltr_run folder create "Data/Backing Datasets" --parent-folder "$PROJECT_FOLDER_RID" --format json)"
    data_folder_rid="$(json_field "$out" rid)"
    [[ -n "$data_folder_rid" ]] || die "folder create did not return an rid: $out"
    state_set DATA_FOLDER_RID "$data_folder_rid"
    log "created Data/Backing Datasets folder: $data_folder_rid"
  else
    log "[dry-run] would run: $PLTR folder create \"Data/Backing Datasets\" --parent-folder $PROJECT_FOLDER_RID --format json --profile $PROFILE"
    data_folder_rid="<pending --apply>"
  fi

  local name csv_name csv_file state_key rid
  for name in helpdesk_sites helpdesk_teams helpdesk_users helpdesk_issues; do
    csv_name="${name#helpdesk_}"
    csv_file="$seed_dir/$csv_name.csv"
    state_key="HELPDESK_$(upper "$csv_name")_DATASET_RID"

    [[ -f "$csv_file" ]] || die "seed file not found: $csv_file"

    if state_has "$state_key"; then
      rid="${!state_key}"
      log "$name already recorded: $rid"
    elif [[ "$APPLY" -eq 1 ]]; then
      local out
      out="$(pltr_run dataset create "$name" --parent-folder "$data_folder_rid" --format json)"
      rid="$(json_field "$out" rid)"
      [[ -n "$rid" ]] || die "dataset create did not return an rid: $out"
      state_set "$state_key" "$rid"
      log "created dataset $name: $rid"
    else
      log "[dry-run] would run: $PLTR dataset create $name --parent-folder $data_folder_rid --format json --profile $PROFILE"
      rid="<pending --apply>"
    fi

    if [[ "$APPLY" -eq 1 && "$rid" != "<pending --apply>" ]]; then
      pltr_run dataset files upload "$csv_file" "$rid"
      log "uploaded $csv_file to $rid"
      pltr_run dataset schema set "$rid" --json-file "$SCRIPT_DIR/schemas/$csv_name.json"
      log "set schema on $rid from $csv_file (inferred; verify createdAt/updatedAt below)"
      pltr_run dataset files list "$rid"
      if [[ "$name" == "helpdesk_issues" ]]; then
        warn "helpdesk_issues: confirm createdAt/updatedAt inferred as TIMESTAMP (README 1 step 3); pltr's --from-csv inference may leave them as STRING, in which case fix the two columns by hand (dataset schema update --add-field, or the Foundry Schema tab) before running 'object-types', since object-type-add-property below declares them TIMESTAMP and the backing column type must match."
      fi
    else
      log "[dry-run] would run: $PLTR dataset files upload $csv_file $rid --profile $PROFILE"
      log "[dry-run] would run: $PLTR dataset schema set $rid --from-csv $csv_file --profile $PROFILE"
    fi
  done
}

# ---------------------------------------------------------------------------
# object-types
# ---------------------------------------------------------------------------

upsert_object_type() {
  local api_name="$1" display_name="$2" primary_key="$3" dataset_state_key="$4" description="$5"
  local state_key="OBJECT_TYPE_ID_$(upper "$api_name")"

  if state_has "$state_key"; then
    log "object type $api_name already recorded: ${!state_key}"
    return 0
  fi

  local dataset_rid="${!dataset_state_key:-}"
  [[ -n "$dataset_rid" ]] || die "$dataset_state_key is not set; run '$0 datasets --apply' first"

  local -a args=(
    ontology object-type-upsert "$ONT"
    --api-name "$api_name" --display-name "$display_name"
    --primary-key "$primary_key" --backing-dataset "$dataset_rid"
    --description "$description" --format json
  )

  if [[ "$APPLY" -eq 1 ]]; then
    args+=(--apply)
    local out
    out="$(pltr_run "${args[@]}")"
    local type_id
    type_id="$(json_field_any "$out" objectTypeId rid id)" || die "could not find an object type id in: $out"
    state_set "$state_key" "$type_id"
    wait_for_object_type "$api_name"
    log "upserted object type $api_name: $type_id"
  else
    log "dry-run plan for object type $api_name:"
    pltr_run "${args[@]}"
  fi
}

add_property() {
  local object_type="$1" prop_api_name="$2" prop_type="$3" display_name="$4"

  local -a args=(
    ontology object-type-add-property "$ONT"
    --object-type "$object_type" --api-name "$prop_api_name" --type "$prop_type"
    --backing-column "$prop_api_name" --display-name "$display_name"
  )

  if [[ "$APPLY" -eq 1 ]]; then
    args+=(--apply)
    local out
    # Idempotent: a re-run after a partial failure must skip properties that
    # already exist instead of dying on the CLI's "already has a property" refusal.
    if out="$(pltr_run "${args[@]}" 2>&1)"; then
      log "added property $object_type.$prop_api_name ($prop_type)"
    elif grep -q "already has a property with API name" <<<"$out"; then
      log "property $object_type.$prop_api_name already present; skipping"
    else
      printf '%s\n' "$out" >&2
      die "add-property failed for $object_type.$prop_api_name"
    fi
  else
    log "dry-run plan for property $object_type.$prop_api_name:"
    pltr_run "${args[@]}"
  fi
}

cmd_object_types() {
  check_pltr_binary
  warn "title keys are not settable via this CLI (object-type-upsert/object-type-add-property have no --title-key flag): set userId->fullName, issueId->title, siteId->name, teamId->name as title keys by hand in Ontology Manager (README 2.2)."
  warn "value types are not settable via this CLI either: --type only accepts primitive types (STRING, TIMESTAMP, ...), not the custom value types helpdeskIssueStatus/helpdeskIssuePriority. status and priority below are added as plain STRING; attach the value types to them by hand (README 2.1/2.2)."

  upsert_object_type HelpdeskUser "Help Desk User" userId HELPDESK_USERS_DATASET_RID \
    "Synthetic help desk user (voice-helpdesk seed data)."
  add_property HelpdeskUser fullName STRING "Full name"
  add_property HelpdeskUser phoneE164 STRING "Phone (E.164)"
  add_property HelpdeskUser pinHash STRING "PIN hash (secret-derived; do not surface in Workshop)"
  add_property HelpdeskUser siteId STRING "Site id"

  upsert_object_type HelpdeskIssue "Help Desk Issue" issueId HELPDESK_ISSUES_DATASET_RID \
    "Help desk issue created by a caller or seeded synthetically."
  add_property HelpdeskIssue title STRING "Title"
  add_property HelpdeskIssue description STRING "Description"
  add_property HelpdeskIssue status STRING "Status"
  add_property HelpdeskIssue priority STRING "Priority"
  add_property HelpdeskIssue resolution STRING "Resolution"
  add_property HelpdeskIssue reportedByUserId STRING "Reported-by user id"
  add_property HelpdeskIssue assignedTeamId STRING "Assigned team id"
  add_property HelpdeskIssue sourceConversationId STRING "Source conversation id"
  add_property HelpdeskIssue createdAt TIMESTAMP "Created at"
  add_property HelpdeskIssue updatedAt TIMESTAMP "Updated at"

  upsert_object_type Site Site siteId HELPDESK_SITES_DATASET_RID "Office site."
  add_property Site name STRING "Name"

  upsert_object_type Team Team teamId HELPDESK_TEAMS_DATASET_RID "Help desk team."
  add_property Team name STRING "Name"
}

# ---------------------------------------------------------------------------
# links
# ---------------------------------------------------------------------------

upsert_link_type() {
  local api_name="$1" from_type_state_key="$2" to_type_state_key="$3" \
    display_name="$4" reverse_api_name="$5" one_side_pk="$6" many_side_prop="$7"
  local state_key="LINK_TYPE_ID_$(upper "$api_name")"

  if state_has "$state_key"; then
    log "link type $api_name already recorded: ${!state_key}"
    return 0
  fi

  local from_id="${!from_type_state_key:-}"
  local to_id="${!to_type_state_key:-}"
  [[ -n "$from_id" && -n "$to_id" ]] || die "$from_type_state_key / $to_type_state_key not set; run '$0 object-types --apply' first"

  local -a args=(
    ontology link-type-upsert "$ONT"
    --api-name "$api_name" --from-object-type-id "$from_id" --to-object-type-id "$to_id"
    --display-name "$display_name" --reverse-api-name "$reverse_api_name"
    --one-side-primary-key "$one_side_pk" --many-side-property "$many_side_prop"
    --format json
  )

  if [[ "$APPLY" -eq 1 ]]; then
    args+=(--apply)
    local out
    out="$(pltr_run "${args[@]}")"
    local link_id
    link_id="$(json_field_any "$out" linkTypeId rid id)" || die "could not find a link type id in: $out"
    state_set "$state_key" "$link_id"
    log "upserted link type $api_name: $link_id"
  else
    log "dry-run plan for link type $api_name:"
    pltr_run "${args[@]}"
  fi
}

cmd_links() {
  check_pltr_binary
  # Verified against zap's dry-run (2026-09-10): --from-object-type-id is the
  # ONE side, --to-object-type-id the MANY side, --api-name the one-to-many
  # direction, --reverse-api-name the many-to-one direction, and
  # --many-side-property takes the property's internal snake_case id.
  # The service reads the many-to-one names (reportedBy, assignedTeam, site).
  upsert_link_type reportedIssues OBJECT_TYPE_ID_HELPDESKUSER OBJECT_TYPE_ID_HELPDESKISSUE \
    "Reported issues" reportedBy userId reported_by_user_id
  upsert_link_type assignedIssues OBJECT_TYPE_ID_TEAM OBJECT_TYPE_ID_HELPDESKISSUE \
    "Assigned issues" assignedTeam teamId assigned_team_id
  upsert_link_type users OBJECT_TYPE_ID_SITE OBJECT_TYPE_ID_HELPDESKUSER \
    "Users" site siteId site_id
}

# ---------------------------------------------------------------------------
# action
# ---------------------------------------------------------------------------

cmd_action() {
  check_pltr_binary
  local state_key="ACTION_TYPE_ID_$(upper "$ACTION_API_NAME")"

  if state_has "$state_key"; then
    log "action type $ACTION_API_NAME already recorded: ${!state_key}"
    return 0
  fi

  [[ -f "$ACTION_DEFINITION_FILE" ]] || die "action definition not found: $ACTION_DEFINITION_FILE"
  python3 -m json.tool "$ACTION_DEFINITION_FILE" >/dev/null || die "$ACTION_DEFINITION_FILE is not valid JSON"

  warn "the internal ActionTypeCreate contract (exact parameter and add-object-rule shapes) is not documented in this repo; $ACTION_DEFINITION_FILE is best-effort (ontology/README.md 2.5). If the dry-run below rejects the parameter or rule shapes, do NOT keep guessing against the live stack -- create the Action by hand in Ontology Manager per ontology/action-create-helpdesk-issue.md instead (about 15 minutes)."

  local -a args=(
    ontology action-type-upsert "$ONT"
    --definition "@$ACTION_DEFINITION_FILE" --format json
  )

  if [[ "$APPLY" -eq 1 ]]; then
    args+=(--apply)
    local out
    out="$(pltr_run "${args[@]}")"
    local action_id
    action_id="$(json_field_any "$out" actionTypeId rid id)" || die "could not find an action type id in: $out"
    state_set "$state_key" "$action_id"
    log "upserted action type $ACTION_API_NAME: $action_id"
  else
    log "dry-run plan for action type $ACTION_API_NAME:"
    pltr_run "${args[@]}"
  fi
}

# ---------------------------------------------------------------------------
# verify (read-only; runs regardless of --apply)
# ---------------------------------------------------------------------------

cmd_verify() {
  check_pltr_binary
  pltr_run ontology object-type-list "$ONT"
  pltr_run ontology object-get "$ONT" HelpdeskIssue 4127
  pltr_run ontology object-linked "$ONT" HelpdeskIssue 4127 assignedTeam
  pltr_run ontology object-get "$ONT" HelpdeskIssue 2210
}

cmd_all() {
  cmd_datasets
  cmd_object_types
  cmd_links
  cmd_action
  cmd_verify
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
  --apply)
    APPLY=1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  datasets | object-types | links | action | verify | all)
    if [[ -n "$SUBCOMMAND" ]]; then
      die "multiple subcommands given ('$SUBCOMMAND' and '$1')"
    fi
    SUBCOMMAND="$1"
    shift
    ;;
  *)
    usage >&2
    die "unknown argument '$1'"
    ;;
  esac
done

if [[ -z "$SUBCOMMAND" ]]; then
  usage >&2
  exit 2
fi

load_state

case "$SUBCOMMAND" in
datasets) cmd_datasets ;;
object-types) cmd_object_types ;;
links) cmd_links ;;
action) cmd_action ;;
verify) cmd_verify ;;
all) cmd_all ;;
esac
