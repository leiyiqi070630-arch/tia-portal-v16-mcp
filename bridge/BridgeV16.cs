using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Web.Script.Serialization;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;

internal static class Bootstrap
{
    public static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length != 1) { Console.Error.WriteLine("Expected path to V16 Siemens.Engineering.dll"); return 2; }
        try
        {
            var file = Path.GetFullPath(args[0]);
            var dir = Path.GetDirectoryName(file);
            var assembly = AssemblyName.GetAssemblyName(file);
            if (assembly.Name != "Siemens.Engineering" || assembly.Version.Major != 16)
                throw new InvalidDataException("V16 Siemens.Engineering.dll is required.");
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs evt) {
                var name = new AssemblyName(evt.Name);
                if (!name.Name.StartsWith("Siemens.Engineering", StringComparison.Ordinal)) return null;
                var candidate = Path.Combine(dir, name.Name + ".dll");
                return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
            };
            Assembly.LoadFrom(file);
            return Start();
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 3; }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Start() { using (var worker = new BridgeV16()) return worker.Serve(); }
}

internal sealed class BridgeV16 : IDisposable
{
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    private TiaPortal portal;
    private Project project;
    private string selected;
    private string copyFile;

    public int Serve()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var stop = false;
            object output;
            try
            {
                var args = json.Deserialize<Dictionary<string, object>>(line);
                var cmd = Arg(args, "op");
                stop = cmd == "quit";
                output = Execute(cmd, args);
            }
            catch (Exception ex)
            {
                output = new { ok = false, error = ex.GetType().Name, message = ex.Message };
            }
            Console.WriteLine(json.Serialize(output));
            Console.Out.Flush();
            if (stop) return 0;
        }
        return 0;
    }

    private static string Arg(Dictionary<string, object> args, string key)
    {
        object value;
        return args.TryGetValue(key, out value) ? value as string : null;
    }

    private object Status()
    {
        return new { ok = true, version = "16.0", connected = portal != null, project = project == null ? null : project.Name,
            project_file_path = copyFile, selected_plc = selected, pid = portal == null ? (int?)null : portal.GetCurrentProcess().Id,
            isolated = true };
    }

    private object Execute(string op, Dictionary<string, object> args)
    {
        switch (op)
        {
            case "probe": return new { ok = true, api = typeof(TiaPortal).Assembly.GetName().Version.ToString() };
            case "status": return Status();
            case "quit":
            case "disconnect": Dispose(); return Status();
            case "open_copy":
                if (portal != null) throw new InvalidOperationException("已有 V16 会话，请先断开。");
                var path = Path.GetFullPath(Arg(args, "path"));
                if (!path.EndsWith(".ap16", StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                    throw new InvalidDataException("必须是存在的 .ap16 工程副本。");
                try
                {
                    portal = new TiaPortal(TiaPortalMode.WithoutUserInterface);
                    project = portal.Projects.Open(new FileInfo(path));
                    copyFile = path;
                    var requested = Arg(args, "plc");
                    var found = FindPlcs();
                    if (!String.IsNullOrWhiteSpace(requested)) selected = Pick(requested, found).Software.Name;
                    else if (found.Count == 1) selected = found[0].Software.Name;
                    return Status();
                }
                catch { Dispose(); throw; }
            case "plcs":
                return new { ok = true, plcs = FindPlcs().Select(p => new { name = p.Software.Name, device = p.Device.Name }).ToArray() };
            case "select":
                selected = Pick(Arg(args, "plc"), FindPlcs()).Software.Name;
                return Status();
            case "inventory":
                return Inventory(Pick(Arg(args, "plc"), FindPlcs()), Arg(args, "tags") == "true");
            case "export":
                return Export(Pick(Arg(args, "plc"), FindPlcs()), Arg(args, "directory"), args.ContainsKey("names") ? args["names"] as IEnumerable : null);
            case "import":
                var plc = Pick(Arg(args, "plc"), FindPlcs()).Software;
                var destination = FindBlockGroup(plc.BlockGroup, Arg(args, "folder"));
                var blocks = destination.Blocks.Import(new FileInfo(Arg(args, "path")), ImportOptions.None);
                return new { ok = true, blocks = blocks.Select(b => new { name = b.Name, number = b.Number, language = b.ProgrammingLanguage.ToString() }).ToArray(),
                    folder = destination.Name, saved = false };
            case "compile":
                return Compile(Pick(Arg(args, "plc"), FindPlcs()), Arg(args, "scope"));
            case "save":
                if (project == null) throw new InvalidOperationException("没有打开工程副本。");
                project.Save();
                return new { ok = true, saved = true, project_file_path = copyFile };
            default: throw new InvalidOperationException("未知操作。");
        }
    }

    private sealed class PlcEntry
    {
        public Device Device;
        public PlcSoftware Software;
    }

    private List<PlcEntry> FindPlcs()
    {
        if (project == null) throw new InvalidOperationException("请先 connect_tia 打开 .ap16 的隔离副本。");
        var result = new List<PlcEntry>();
        foreach (var device in project.Devices) ScanDevice(device, result);
        foreach (var device in project.UngroupedDevicesGroup.Devices) ScanDevice(device, result);
        foreach (DeviceUserGroup group in project.DeviceGroups) ScanGroup(group, result);
        return result.GroupBy(p => new { device = p.Device.Name, plc = p.Software.Name }).Select(g => g.First()).ToList();
    }

    private static void ScanGroup(DeviceUserGroup group, List<PlcEntry> result)
    {
        foreach (var device in group.Devices) ScanDevice(device, result);
        foreach (DeviceUserGroup child in group.Groups) ScanGroup(child, result);
    }
    private static void ScanDevice(Device device, List<PlcEntry> result)
    {
        foreach (var item in device.DeviceItems) ScanItem(device, item, result);
    }
    private static void ScanItem(Device device, DeviceItem item, List<PlcEntry> result)
    {
        var container = ((IEngineeringServiceProvider)item).GetService<SoftwareContainer>();
        var plc = container == null ? null : container.Software as PlcSoftware;
        if (plc != null) result.Add(new PlcEntry { Device = device, Software = plc });
        foreach (var child in item.DeviceItems) ScanItem(device, child, result);
    }

    private PlcEntry Pick(string requested, List<PlcEntry> plcs)
    {
        var name = String.IsNullOrWhiteSpace(requested) ? selected : requested;
        if (name == null && plcs.Count == 1) return plcs[0];
        var matches = plcs.Where(p => String.Equals(p.Software.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length != 1) throw new InvalidOperationException("请明确选择唯一的 PLC，先调用 list_plcs。");
        return matches[0];
    }

    private static IEnumerable<KeyValuePair<string, PlcBlock>> Blocks(PlcBlockGroup group, string path)
    {
        foreach (var block in group.Blocks) yield return new KeyValuePair<string, PlcBlock>(path, block);
        foreach (PlcBlockGroup child in group.Groups)
            foreach (var block in Blocks(child, path + "/" + child.Name)) yield return block;
    }

    private static IEnumerable<KeyValuePair<string, PlcTagTable>> Tables(PlcTagTableGroup group, string path)
    {
        foreach (var table in group.TagTables) yield return new KeyValuePair<string, PlcTagTable>(path, table);
        foreach (PlcTagTableGroup child in group.Groups)
            foreach (var table in Tables(child, path + "/" + child.Name)) yield return table;
    }

    private static PlcBlockGroup FindBlockGroup(PlcBlockGroup root, string requested)
    {
        if (String.IsNullOrWhiteSpace(requested)) return root;
        foreach (var segment in requested.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var current = root;
            root = current.Groups.Cast<PlcBlockGroup>().SingleOrDefault(g => String.Equals(g.Name, segment, StringComparison.OrdinalIgnoreCase));
            if (root == null) throw new InvalidOperationException("程序块文件夹不存在：" + segment);
        }
        return root;
    }

    private static object Inventory(PlcEntry plc, bool details)
    {
        return new { ok = true, plc_name = plc.Software.Name, device = plc.Device.Name,
            blocks = Blocks(plc.Software.BlockGroup, "").Select(x => new { folder = x.Key, name = x.Value.Name, number = x.Value.Number, language = x.Value.ProgrammingLanguage.ToString() }).ToArray(),
            tag_tables = Tables(plc.Software.TagTableGroup, "").Select(x => new { folder = x.Key, name = x.Value.Name, tag_count = x.Value.Tags.Count,
                tags = details ? x.Value.Tags.Select(t => new { name = t.Name, data_type = t.DataTypeName, address = t.LogicalAddress }).ToArray() : null }).ToArray() };
    }

    private static object Export(PlcEntry plc, string folder, IEnumerable names)
    {
        var blocks = Blocks(plc.Software.BlockGroup, "").ToArray();
        if (names != null)
        {
            var selected = new List<KeyValuePair<string, PlcBlock>>();
            foreach (var name in names.Cast<string>().Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var matches = blocks.Where(b => String.Equals(b.Value.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (matches.Length != 1) throw new InvalidOperationException("找不到唯一程序块：" + name);
                selected.Add(matches[0]);
            }
            blocks = selected.ToArray();
        }
        var files = new List<string>();
        foreach (var block in blocks)
        {
            var label = String.Concat(block.Value.Name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c));
            var file = Path.Combine(folder, (files.Count + 1).ToString("D3") + "_" + label + ".xml");
            block.Value.Export(new FileInfo(file), ExportOptions.WithDefaults);
            files.Add(file);
        }
        return new { ok = true, plc_name = plc.Software.Name, files = files, format = "simaticml" };
    }

    private static object Compile(PlcEntry plc, string scope)
    {
        var messages = new List<object>();
        int errors = 0, warnings = 0;
        if (scope == "hardware" || scope == "both")
            ReadCompile("hardware", ((IEngineeringServiceProvider)plc.Device).GetService<ICompilable>(), messages, ref errors, ref warnings);
        if (scope == "software" || scope == "both")
            ReadCompile("software", ((IEngineeringServiceProvider)plc.Software).GetService<ICompilable>(), messages, ref errors, ref warnings);
        return new { ok = errors == 0, scope = scope, errors = errors, warnings = warnings, messages = messages };
    }

    private static void ReadCompile(string scope, ICompilable target, List<object> rows, ref int errors, ref int warnings)
    {
        if (target == null) throw new InvalidOperationException("当前对象不提供编译服务：" + scope);
        var returned = target.Compile();
        errors += returned.ErrorCount;
        warnings += returned.WarningCount;
        foreach (var msg in returned.Messages) WalkMessage(scope, msg, rows);
    }

    private static void WalkMessage(string scope, CompilerResultMessage msg, List<object> rows)
    {
        rows.Add(new { scope = scope, path = msg.Path, state = msg.State.ToString(), description = msg.Description });
        foreach (var child in msg.Messages) WalkMessage(scope, child, rows);
    }

    public void Dispose()
    {
        var oldProject = project;
        var oldPortal = portal;
        project = null; portal = null; selected = null; copyFile = null;
        try { if (oldProject != null) oldProject.Close(); }
        finally { if (oldPortal != null) oldPortal.Dispose(); }
    }
}
