-- VYPODE FOR LETTERBOXD — Supabase Schema v5.0.0
-- Run this in your Supabase SQL Editor to set up the database.
-- Prerequisites: Create a Supabase project and enable Google auth provider.

-- ─── User Profiles ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  letterboxd_username TEXT,
  last_push_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security: users can only read/write their own profile
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON user_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- ─── Film States ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS film_states (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  watched       BOOLEAN DEFAULT FALSE,
  watched_at    TIMESTAMPTZ,
  liked         BOOLEAN DEFAULT FALSE,
  liked_at      TIMESTAMPTZ,
  watchlist     BOOLEAN DEFAULT FALSE,
  watchlist_at  TIMESTAMPTZ,
  skipped       BOOLEAN DEFAULT FALSE,
  skipped_at    TIMESTAMPTZ,
  last_action   TEXT,
  source        TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, slug)
);

-- Row Level Security: users can only access their own film states
ALTER TABLE film_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own film states"
  ON film_states FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own film states"
  ON film_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own film states"
  ON film_states FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own film states"
  ON film_states FOR DELETE
  USING (auth.uid() = user_id);

-- ─── Indexes for performance ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_film_states_user_id ON film_states(user_id);
CREATE INDEX IF NOT EXISTS idx_film_states_user_slug ON film_states(user_id, slug);
CREATE INDEX IF NOT EXISTS idx_film_states_updated ON film_states(user_id, updated_at DESC);

-- ─── Upsert support ──────────────────────────────────────────────────
-- The extension uses POST with ?on_conflict=user_id,slug for upserts.
-- Supabase PostgREST handles this via the UNIQUE constraint above.
-- No additional function needed.

-- ─── Notes ────────────────────────────────────────────────────────────
-- 1. Enable Google auth in Supabase Dashboard > Authentication > Providers
-- 2. Copy your Supabase URL and anon key into background.js
-- 3. Add your Chrome extension ID to the Google OAuth redirect URIs
-- 4. Data is encrypted at rest by Supabase (AES-256)
-- 5. All queries go through RLS — no admin access from the extension
