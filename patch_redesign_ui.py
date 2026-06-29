import re

def patch_app():
    with open('App.tsx', 'r', encoding='utf-8') as f:
        data = f.read()

    # 1. Add imports at the very top (after first import)
    if 'ModernHomeUI' not in data:
        data = data.replace(
            'import React',
            'import ModernHomeUI from "./src/components/ModernHomeUI";\nimport ModernSettingsPage from "./src/components/ModernSettingsPage";\nimport React',
            1
        )

    # 2. Patch HomeView
    homeview_idx = data.find('function HomeView(')
    if homeview_idx != -1:
        homeview_return_idx = data.find('return (', homeview_idx)
        if homeview_return_idx != -1:
            homeview_end_match = re.search(r'^  \);\n}', data[homeview_idx:], re.MULTILINE)
            if homeview_end_match:
                homeview_end_idx = homeview_idx + homeview_end_match.end()
                
                # We replace everything from return ( to the end of the function
                new_homeview_return = """return (
    <ModernHomeUI 
      {...arguments[0]} 
    />
  );
}"""
                data = data[:homeview_return_idx] + new_homeview_return + data[homeview_end_idx:]

    # 3. Patch SettingsPage
    settings_idx = data.find('function SettingsPage(')
    if settings_idx != -1:
        settings_return_idx = data.find('return (', settings_idx)
        if settings_return_idx != -1:
            settings_end_match = re.search(r'^  \);\n}', data[settings_idx:], re.MULTILINE)
            if settings_end_match:
                settings_end_idx = settings_idx + settings_end_match.end()
                
                new_settings_return = """return (
    <ModernSettingsPage 
      {...arguments[0]} 
    />
  );
}"""
                data = data[:settings_return_idx] + new_settings_return + data[settings_end_idx:]

    with open('App.tsx', 'w', encoding='utf-8') as f:
        f.write(data)

    print("Patched App.tsx successfully.")

if __name__ == "__main__":
    patch_app()
