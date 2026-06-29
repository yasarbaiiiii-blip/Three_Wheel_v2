import sys

filepath = sys.argv[1]
with open(filepath, chr(114)) as f:
    content = f.read()

# Fix 1: Change line colors - make selected lines red instead of always green
old_style = chr(39)+chr(44)+chr(10)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(99)+chr(111)+chr(108)+chr(111)+chr(114)+chr(58)+chr(32)+chr(39)+chr(35)+chr(49)+chr(54)+chr(97)+chr(51)+chr(52)+chr(97)+chr(39)
new_style = chr(39)+chr(44)+chr(10)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(32)+chr(99)+chr(111)+chr(108)+chr(111)+chr(114)+chr(58)+chr(32)+chr(105)+chr(116)+chr(101)+chr(109)+chr(32)+chr(63)+chr(32)+chr(39)+chr(35)+chr(101)+chr(102)+chr(52)+chr(52)+chr(52)+chr(52)+chr(39)+chr(32)+chr(58)+chr(32)+chr(39)+chr(35)+chr(49)+chr(54)+chr(97)+chr(51)+chr(52)+chr(97)+chr(39)

if old_style in content:
    content = content.replace(old_style, new_style, 1)
    print(chr(83)+chr(116)+chr(121)+chr(108)+chr(101)+chr(32)+chr(102)+chr(105)+chr(120)+chr(101)+chr(100))
else:
    print(chr(78)+chr(79)+chr(84)+chr(32)+chr(70)+chr(79)+chr(85)+chr(78)+chr(68))

with open(filepath, chr(119)) as f:
    f.write(content)
