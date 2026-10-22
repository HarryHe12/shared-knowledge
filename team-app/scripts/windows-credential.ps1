$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Text;
public static class KnowledgeCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public uint Flags, Type;
  public string TargetName, Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize;
  public IntPtr CredentialBlob;
  public uint Persist, AttributeCount;
  public IntPtr Attributes;
  public string TargetAlias, UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool WriteNative(ref Credential credential, uint flags);
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool ReadNative(string target, uint type, uint flags, out IntPtr credential);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool DeleteNative(string target, uint type, uint flags);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
 public static string Read(string target) {
  IntPtr pointer;
  if(!ReadNative(target,1,0,out pointer)) { int code=Marshal.GetLastWin32Error(); if(code==1168)return ""; throw new Win32Exception(code); }
  try { var c=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential)); byte[] bytes=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,bytes,0,bytes.Length); try{return Encoding.UTF8.GetString(bytes);}finally{Array.Clear(bytes,0,bytes.Length);} }
  finally{CredFree(pointer);}
 }
 public static void Write(string target,string value) {
  byte[] bytes=Encoding.UTF8.GetBytes(value); if(bytes.Length>2560)throw new ArgumentException();
  IntPtr pointer=Marshal.AllocHGlobal(bytes.Length);
  try { Marshal.Copy(bytes,0,pointer,bytes.Length); var c=new Credential { Type=1,TargetName=target,CredentialBlobSize=(uint)bytes.Length,CredentialBlob=pointer,Persist=2,UserName="shared-knowledge" }; if(!WriteNative(ref c,0))throw new Win32Exception(Marshal.GetLastWin32Error()); }
  finally { for(int i=0;i<bytes.Length;i++)Marshal.WriteByte(pointer,i,0);Marshal.FreeHGlobal(pointer);Array.Clear(bytes,0,bytes.Length); }
 }
 public static void Delete(string target) { if(!DeleteNative(target,1,0)){int code=Marshal.GetLastWin32Error();if(code!=1168)throw new Win32Exception(code);} }
}
'@
 $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
 if(-not $request.service.StartsWith('shared-knowledge:')){throw 'Invalid target'}
 switch($request.operation) {
  'read' { $value=[KnowledgeCredential]::Read($request.service) }
  'write' { [KnowledgeCredential]::Write($request.service,$request.value);$value='' }
  'delete' { [KnowledgeCredential]::Delete($request.service);$value='' }
  default { throw 'Invalid operation' }
 }
 [Console]::Out.Write((@{value=$value} | ConvertTo-Json -Compress))
} catch { [Console]::Error.Write('Windows credential storage failed'); exit 1 }
