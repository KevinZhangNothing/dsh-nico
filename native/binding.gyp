{
  "targets": [
    {
      "target_name": "hotkey_tap",
      "sources": [ "hotkey_tap.mm" ],
      "xcode_settings": {
        "FRAMEWORK_SEARCH_PATHS": [ "/System/Library/Frameworks" ],
        "OTHER_LDFLAGS": [
          "-framework", "CoreGraphics",
          "-framework", "Foundation",
          "-framework", "AppKit"
        ]
      }
    }
  ]
}
