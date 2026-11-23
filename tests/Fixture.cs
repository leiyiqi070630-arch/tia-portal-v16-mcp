using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
internal static class Fixture
{
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var api = Path.GetFullPath(args[0]);
        AppDomain.CurrentDomain.AssemblyResolve += (sender, evt) => {
            var name = new AssemblyName(evt.Name);
            var p = Path.Combine(Path.GetDirectoryName(api), name.Name + ".dll");
            return name.Name.StartsWith("Siemens.Engineering") && File.Exists(p) ? Assembly.LoadFrom(p) : null;
        };
        Assembly.LoadFrom(api);
        try { return Build(args[1], args[2]); }
        catch(Exception ex) { Console.Error.WriteLine(ex); return 2; }
    }
    private static IEnumerable<DeviceItem> Walk(DeviceItem item)
    { yield return item; foreach (var child in item.DeviceItems) foreach (var node in Walk(child)) yield return node; }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Build(string target, string catalogue)
    {
        var root = new DirectoryInfo(target);
        if (!root.Exists || root.EnumerateFileSystemInfos().Any()) throw new InvalidOperationException("Expected a new, empty scratch directory.");
        using (var portal = new TiaPortal(TiaPortalMode.WithoutUserInterface))
        {
            var project = portal.Projects.Create(root, "TestV16");
            Console.WriteLine("isolated_pid=" + portal.GetCurrentProcess().Id);
            try
            {
                var device = project.Devices.CreateWithItem(catalogue,"PLC_1","PLC Station");
                var plc = device.DeviceItems.SelectMany(Walk).Select(i => i.GetService<SoftwareContainer>()).Where(c => c != null).Select(c => c.Software).OfType<PlcSoftware>().Single();
                var main = plc.BlockGroup.Blocks.Single(b => b.Number == 1 && b is OB);
                Console.WriteLine("source=" + main.Name + " " + main.ProgrammingLanguage + " #" + main.Number);
                main.Export(new FileInfo(Path.Combine(target,"Main.xml")), ExportOptions.WithDefaults);
                main.Delete();
                project.Save();
                Console.WriteLine("fixture=" + Path.Combine(target,"TestV16","TestV16.ap16"));
            }
            finally { project.Close(); }
        }
        return 0;
    }
}
