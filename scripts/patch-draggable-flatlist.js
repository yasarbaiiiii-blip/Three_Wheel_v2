const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function patchFile(relativePath, replacements) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    console.warn(`[patch-draggable-flatlist] Missing ${relativePath}; skipping`);
    return;
  }

  let source = fs.readFileSync(filePath, "utf8");
  let next = source;

  for (const [from, to] of replacements) {
    if (!next.includes(from)) {
      continue;
    }
    next = next.split(from).join(to);
  }

  if (next !== source) {
    fs.writeFileSync(filePath, next);
    console.log(`[patch-draggable-flatlist] Patched ${relativePath}`);
  }
}

const sourceComponentPatch = [
  [
    `import {
  ListRenderItem,
  FlatListProps,
  LayoutChangeEvent,
  InteractionManager,
} from "react-native";
import {
  FlatList,
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";`,
    `import {
  ListRenderItem,
  FlatList,
  FlatListProps,
  LayoutChangeEvent,
  InteractionManager,
} from "react-native";
import {
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";`,
  ],
];

const sourceTypesPatch = [
  [
    `  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from "react-native";
import { useAnimatedValues } from "./context/animatedValueContext";
import { FlatList } from "react-native-gesture-handler";`,
    `  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
  FlatList,
} from "react-native";
import { useAnimatedValues } from "./context/animatedValueContext";`,
  ],
];

const moduleComponentPatch = [
  [
    `import { InteractionManager } from "react-native";
import { FlatList, Gesture, GestureDetector } from "react-native-gesture-handler";`,
    `import { FlatList, InteractionManager } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";`,
  ],
];

const commonJsComponentPatch = [
  [
    `_reactNativeReanimated.default.createAnimatedComponent(_reactNativeGestureHandler.FlatList)`,
    `_reactNativeReanimated.default.createAnimatedComponent(_reactNative.FlatList)`,
  ],
  [
    `_reactNativeReanimated.default.createAnimatedComponent(_reactNativeGestureHandler.default.FlatList)`,
    `_reactNativeReanimated.default.createAnimatedComponent(_reactNative.FlatList)`,
  ],
];

const typePatch = [
  [
    `import { FlatListProps, LayoutChangeEvent, StyleProp, ViewStyle } from "react-native";
import { useAnimatedValues } from "./context/animatedValueContext";
import { FlatList } from "react-native-gesture-handler";`,
    `import { FlatListProps, LayoutChangeEvent, StyleProp, ViewStyle, FlatList } from "react-native";
import { useAnimatedValues } from "./context/animatedValueContext";`,
  ],
];

const componentTypePatch = [
  [
    `import { FlatListProps } from "react-native";
import { FlatList } from "react-native-gesture-handler";`,
    `import { FlatList, FlatListProps } from "react-native";`,
  ],
];

const refContextPatch = [
  [
    `import { FlatList } from "react-native-gesture-handler";`,
    `import { FlatList } from "react-native";`,
  ],
];

const nestableSourcePatch = [
  [
    `import { findNodeHandle, LogBox } from "react-native";`,
    `import { findNodeHandle, FlatList, LogBox } from "react-native";`,
  ],
  [
    `import { FlatList } from "react-native-gesture-handler";
`,
    "",
  ],
];

const nestableTypePatch = [
  [
    `import React from "react";
import Animated from "react-native-reanimated";
import { DraggableFlatListProps } from "../types";
import { FlatList } from "react-native-gesture-handler";`,
    `import React from "react";
import { FlatList } from "react-native";
import Animated from "react-native-reanimated";
import { DraggableFlatListProps } from "../types";`,
  ],
];

patchFile("node_modules/react-native-draggable-flatlist/src/components/DraggableFlatList.tsx", sourceComponentPatch);
patchFile("node_modules/react-native-draggable-flatlist/src/types.ts", sourceTypesPatch);
patchFile("node_modules/react-native-draggable-flatlist/lib/module/components/DraggableFlatList.js", moduleComponentPatch);
patchFile("node_modules/react-native-draggable-flatlist/lib/commonjs/components/DraggableFlatList.js", commonJsComponentPatch);
patchFile("node_modules/react-native-draggable-flatlist/lib/typescript/types.d.ts", typePatch);
patchFile("node_modules/react-native-draggable-flatlist/lib/typescript/components/DraggableFlatList.d.ts", componentTypePatch);
patchFile("node_modules/react-native-draggable-flatlist/src/context/refContext.tsx", refContextPatch);
patchFile("node_modules/react-native-draggable-flatlist/lib/typescript/context/refContext.d.ts", refContextPatch);
patchFile("node_modules/react-native-draggable-flatlist/src/components/NestableDraggableFlatList.tsx", nestableSourcePatch);
patchFile("node_modules/react-native-draggable-flatlist/lib/typescript/components/NestableDraggableFlatList.d.ts", nestableTypePatch);
