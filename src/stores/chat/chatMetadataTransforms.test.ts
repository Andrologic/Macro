import { describe, expect, it } from "bun:test";

import {
  buildManualFeatureFallbackMetadata,
  extractJsonObjectFromModelOutput,
  extractManualFeatureMetadataFromModelOutput,
  extractMetadataFromModelOutput,
  getConversationFallbackDescription,
  getConversationFallbackTitle,
  normalizeManualFeatureSlugInput,
} from "./chatMetadataTransforms";

describe("chatMetadataTransforms", () => {
  it("keeps fallback text, whitespace normalization and length limits", () => {
    expect(getConversationFallbackTitle(" \n\t ")).toBe("New Conversation");
    expect(getConversationFallbackDescription(" \n\t ")).toBe("General discussion.");
    expect(getConversationFallbackTitle("  Résumé\n du  projet et des choix importants "))
      .toBe("Résumé du projet et des choix");
    expect(getConversationFallbackDescription("  Résumé\n du  projet "))
      .toBe("Résumé du projet");
    expect(getConversationFallbackTitle("é".repeat(90))).toBe("é".repeat(72));
    expect(getConversationFallbackDescription("é".repeat(200))).toBe("é".repeat(180));
  });

  it("extracts JSON after discarding thinking and surrounding model text", () => {
    expect(extractJsonObjectFromModelOutput(
      '<THINK>{"title":"Discard"}</THINK>\n```json\n{"title":"Été","description":"Projet"}\n```',
    )).toEqual({ title: "Été", description: "Projet" });
    expect(() => extractJsonObjectFromModelOutput("No object")).toThrow("No JSON object found");
    expect(() => extractJsonObjectFromModelOutput("{broken}")).toThrow(SyntaxError);
  });

  it("normalizes generated metadata without changing its language", () => {
    expect(extractMetadataFromModelOutput(JSON.stringify({
      title: "  Réparer\n le  résumé ", description: " Résoudre\t la régression. ",
    }))).toEqual({ title: "Réparer le résumé", description: "Résoudre la régression." });
    expect(extractMetadataFromModelOutput(JSON.stringify({
      title: "é".repeat(90), description: "à".repeat(200),
    }))).toEqual({ title: "é".repeat(72), description: "à".repeat(180) });
  });

  it("rejects missing, non-string and empty metadata values", () => {
    for (const value of [{}, { title: 1, description: "Body" }, { title: "Title", description: null }]) {
      expect(() => extractMetadataFromModelOutput(JSON.stringify(value))).toThrow("Invalid metadata shape");
    }
    for (const value of [{ title: " \n", description: "Body" }, { title: "Title", description: "\t" }]) {
      expect(() => extractMetadataFromModelOutput(JSON.stringify(value))).toThrow("Empty metadata values");
    }
  });

  it("normalizes branch leaves with the existing fallback and slug limit", () => {
    expect(normalizeManualFeatureSlugInput(" refs/heads/Feature/Checkout Summary/ "))
      .toBe("checkout-summary");
    expect(normalizeManualFeatureSlugInput("feature\\Some_Name.v2")).toBe("some_name.v2");
    expect(normalizeManualFeatureSlugInput(" --- ")).toBe("work");
    expect(normalizeManualFeatureSlugInput("a".repeat(80))).toBe("a".repeat(64));
  });

  it("accepts every existing manual task kind and normalizes its metadata", () => {
    for (const taskKind of ["feature", "bugfix", "hotfix", "direct"] as const) {
      expect(extractManualFeatureMetadataFromModelOutput(JSON.stringify({
        title: "  Réparer\n le résumé ", description: " Corriger\t le texte. ",
        featureSlug: "refs/heads/Feature/Some Work", taskKind,
      }))).toEqual({
        title: "Réparer le résumé", description: "Corriger le texte.", featureSlug: "some-work", taskKind,
      });
    }
  });

  it("rejects invalid manual metadata while retaining the empty slug fallback", () => {
    const metadata = { title: "Title", description: "Body", featureSlug: "slug", taskKind: "feature" };
    for (const patch of [{ taskKind: "unknown" }, { featureSlug: null }, { description: 1 }, { title: null }]) {
      expect(() => extractManualFeatureMetadataFromModelOutput(JSON.stringify({ ...metadata, ...patch })))
        .toThrow("Invalid manual feature metadata shape");
    }
    expect(() => extractManualFeatureMetadataFromModelOutput(JSON.stringify({ ...metadata, title: " " })))
      .toThrow("Empty manual feature metadata values");
    expect(extractManualFeatureMetadataFromModelOutput(JSON.stringify({ ...metadata, featureSlug: "" })).featureSlug)
      .toBe("work");
  });

  it("preserves fallback task classification and urgent fix precedence", () => {
    expect(buildManualFeatureFallbackMetadata("")).toEqual({
      title: "New Conversation", description: "General discussion.", featureSlug: "new-conversation", taskKind: "feature",
    });
    expect(buildManualFeatureFallbackMetadata("Ajouter un résumé").taskKind).toBe("feature");
    expect(buildManualFeatureFallbackMetadata("Réparer le résumé").taskKind).toBe("bugfix");
    expect(buildManualFeatureFallbackMetadata("Le résumé", "Corriger la régression").taskKind).toBe("bugfix");
    expect(buildManualFeatureFallbackMetadata("Corriger la régression", "Incident de production").taskKind).toBe("hotfix");
  });
});
