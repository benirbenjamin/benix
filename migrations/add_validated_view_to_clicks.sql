-- Migration: Add validated_view column to clicks table
-- This tracks whether a click was counted after a 30-second validated view

ALTER TABLE clicks ADD COLUMN validated_view BOOLEAN DEFAULT FALSE;

-- Update existing clicks to mark them as validated (for backward compatibility)
UPDATE clicks SET validated_view = TRUE WHERE is_counted = TRUE;
