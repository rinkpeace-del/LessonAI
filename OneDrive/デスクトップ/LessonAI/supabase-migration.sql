-- 友達紹介機能: Supabase マイグレーション
-- Supabase ダッシュボード → SQL Editor で実行してください

-- profiles テーブルに紹介関連カラムを追加
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS referral_code  VARCHAR(8)   UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by   VARCHAR(8),
  ADD COLUMN IF NOT EXISTS referral_count INT          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;

-- 高速検索用インデックス
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON profiles(referral_code);

-- referrals テーブルを新規作成
CREATE TABLE IF NOT EXISTS referrals (
  id          BIGSERIAL   PRIMARY KEY,
  referrer_id UUID        NOT NULL REFERENCES profiles(id),
  referred_id UUID        NOT NULL REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  rewarded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
