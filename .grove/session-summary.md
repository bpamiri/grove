# Session Summary: W-061

## Summary

Implemented the Skills Library UI in the Settings page (issue #142). Added a new "Skills Library" section between Trees and Budget that lets users browse installed skills, install new ones from local paths or Git URLs, and remove existing skills with confirmation. The UI subscribes to `skill:installed` and `skill:removed` WebSocket events for real-time updates.

## Changes Made

### API Client (`web/src/api/client.ts`)
- Added `SkillManifest` interface (frontend copy of server type)
- Added `fetchSkills()`, `installSkill(source)`, and `removeSkill(name)` API functions

### useSkills Hook (`web/src/hooks/useSkills.ts`) — NEW
- Fetches skills list on mount via `GET /api/skills`
- Re-fetches on `skill:installed` / `skill:removed` WebSocket events
- Exposes `install` and `remove` actions

### App (`web/src/App.tsx`)
- Imported and instantiated `useSkills` hook
- Wired `skillsState.handleWsMessage` into the WebSocket message handler
- Passed skills state props to both Settings instances (mobile + desktop)

### Settings (`web/src/components/Settings.tsx`)
- Added Skills Library section with:
  - Card per installed skill showing name, version, description, author, file count, and suggested steps
  - Install form (unified input for local path or Git URL)
  - Remove button with inline two-step confirmation
  - Loading and error states

## Files Modified
- `web/src/api/client.ts` — skill API functions and SkillManifest type
- `web/src/hooks/useSkills.ts` — new hook file
- `web/src/App.tsx` — useSkills wiring + Settings props
- `web/src/components/Settings.tsx` — Skills Library section

## Next Steps
- None — feature is complete as specified in issue #142
