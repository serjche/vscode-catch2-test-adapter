export interface GroupByExecutable extends TestGrouping {
  label?: string;
  description?: string;
}

export interface GroupBySource extends TestGrouping {
  label?: string;
  description?: string;

  groupUngroupedTo?: string;
}

export interface GroupByTags extends TestGrouping {
  tags?: string[][];

  label?: string; // ${tags} will by substituted
  description?: string;

  groupUngroupedTo?: string;
}

export interface GroupByTagRegex extends TestGrouping {
  regexes?: string[];

  label?: string; // ${match}, ${match_lowercased}, ${match_upperfirst} will by substituted
  description?: string;

  groupUngroupedTo?: string;
}

export type GroupByRegex = GroupByTagRegex;

///

export interface TestGrouping {
  groupByExecutable?: GroupByExecutable;

  groupBySource?: GroupBySource;

  groupByTags?: GroupByTags;

  groupByTagRegex?: GroupByTagRegex;

  groupByRegex?: GroupByRegex;

  tagFormat?: string; // use "[${tag}]"
}
