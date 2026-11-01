-- Electric: read-only access to the synchronized tables. Electric reads the replication log
-- through this publication; its role owns none of the tables.
GRANT USAGE ON SCHEMA public TO electric;--> statement-breakpoint
GRANT SELECT ON conversations, items, item_chunks TO electric;--> statement-breakpoint
ALTER TABLE conversations REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE items REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE item_chunks REPLICA IDENTITY FULL;--> statement-breakpoint
CREATE PUBLICATION electric_publication_default FOR TABLE conversations, items, item_chunks;
