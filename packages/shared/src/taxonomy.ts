export const TAXONOMY = [
  "Technology/Coding",
  "Technology/AI",
  "Technology/Robotics",
  "Economy",
  "Science",
  "Politics",
  "Business",
  "Infrastructure/USPS",
  "Infrastructure/Internet",
  "Infrastructure/Energy",
  "Culture",
  "Crafting",
  "Other",
] as const;

export type Topic = (typeof TAXONOMY)[number];
